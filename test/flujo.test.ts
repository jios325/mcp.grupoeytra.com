import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { ClienteAsistente, type Persona, type Resultado } from '../src/asistente.js';
import { Almacen } from '../src/auth/almacen.js';
import { LoginSupabase, type PasoLogin } from '../src/auth/login.js';
import { s256 } from '../src/auth/oauth.js';
import type { Config } from '../src/config.js';
import { CmsPublico } from '../src/publico/cms.js';
import { Sitio } from '../src/publico/sitio.js';
import { crearApp } from '../src/servidor.js';

// Flujo completo contra la app real con el CMS y Supabase falsos: descubrimiento OAuth, registro,
// login (con y sin segundo factor), token, lazy auth, alcance por rol y rotación del refresh token.

const PERSONAS: Record<string, Resultado<Persona>> = {
  'u-cliente': {
    ok: true,
    data: {
      user: { id: 'u-cliente', name: 'Admin Brisa', email: 'cliente@x.test', scope: 'client', role: 'client_admin' },
      company: { id: 'c1', name: 'Condominio Brisa' },
      tools: ['account_statement', 'invoice_files', 'lab_results', 'create_request', 'catalog_quote'],
    },
  },
  'u-equipo': {
    ok: true,
    data: { user: { id: 'u-equipo', name: 'Lab', email: 'equipo@x.test', scope: 'staff', role: 'lab' }, company: null, tools: ['daily_summary'] },
  },
  'u-finanzas': { ok: false, status: 403, error: 'Las cuentas con doble factor obligatorio no usan el asistente.' },
};

class AsistenteFalso extends ClienteAsistente {
  llamadas: { metodo: string; ruta: string; usuario?: string; cuerpo?: unknown }[] = [];
  constructor() {
    super({ asistenteUrl: 'http://cms.invalid', asistenteLlave: 'x' });
  }
  override async llamar<T>(metodo: 'GET' | 'POST', ruta: string, op: { usuario?: string; cuerpo?: unknown } = {}): Promise<Resultado<T>> {
    this.llamadas.push({ metodo, ruta, usuario: op.usuario, cuerpo: op.cuerpo });
    if (ruta === '/me') return (PERSONAS[op.usuario ?? ''] ?? { ok: false, status: 404, error: 'Usuario no registrado en el CMS.' }) as Resultado<T>;
    if (ruta === '/catalog') return { ok: true, data: { products: [{ slug: 'cloro', price: 100 }] } as T };
    if (ruta === '/account') return { ok: true, data: { company: 'Condominio Brisa', total_due: 1740 } as T };
    if (ruta === '/summary') return { ok: true, data: { billed: 1 } as T };
    if (ruta === '/requests') return { ok: true, data: { folio: 'SOL-1' } as T };
    return { ok: false, status: 404, error: 'no' };
  }
}

class LoginFalso extends LoginSupabase {
  constructor() {
    super({ supabaseUrl: 'http://supabase.invalid', supabaseLlavePublicable: 'x' });
  }
  override async conContrasena(correo: string, contrasena: string): Promise<PasoLogin> {
    if (contrasena !== 'bien') return { tipo: 'error', mensaje: 'Correo o contraseña incorrectos.' };
    if (correo === 'equipo@x.test') return { tipo: 'segundo_factor', sesion: { access_token: 'a', refresh_token: 'r' }, factorId: 'f' };
    const ids: Record<string, string> = { 'cliente@x.test': 'u-cliente', 'finanzas@x.test': 'u-finanzas' };
    return ids[correo] ? { tipo: 'listo', usuarioId: ids[correo]! } : { tipo: 'error', mensaje: 'Correo o contraseña incorrectos.' };
  }
  override async conCodigo(_s: unknown, _f: string, codigo: string): Promise<PasoLogin> {
    return codigo === '123456' ? { tipo: 'listo', usuarioId: 'u-equipo' } : { tipo: 'error', mensaje: 'El código no es válido.' };
  }
  override async descartar() {}
}

class CmsFalso extends CmsPublico {
  pedidos: Parameters<CmsPublico['catalogo']>[0][] = [];
  override async catalogo(opciones: Parameters<CmsPublico['catalogo']>[0] = {}) {
    this.pedidos.push(opciones);
    const productos = [{ slug: 'cloro', name: 'Cloro', category: 'quimicos', price: 100, sale_mode: 'shipping', recurring_interval: null, pack_quantity: 1, pack_unit: 'L', summary: null }];
    return { nota: 'Precios de lista', orden: opciones.orden ?? 'destacados', total: 1, hay_mas: false, productos, tienda: 'https://grupoeytra.com/tienda' } as Awaited<ReturnType<CmsPublico['catalogo']>>;
  }
  // Como en producción hoy: el blog no está en el CMS.
  override async articulos() {
    return [];
  }
  override async articulo() {
    return null;
  }
  override async temasBlog() {
    return [];
  }
}

const cmsFalso = new CmsFalso({ supabaseUrl: 'http://supabase.invalid', supabaseLlavePublicable: 'x' });

class SitioFalso extends Sitio {
  override async indiceSitio() {
    return {
      resumen: '# Grupo Eytra',
      entradas: [
        { titulo: 'Laboratorio', url: 'https://grupoeytra.com/laboratorio', descripcion: 'análisis', seccion: 'Lab' },
        { titulo: 'Agua de calderas', url: 'https://grupoeytra.com/blog/agua-calderas', descripcion: 'tratamiento interno', seccion: 'Guías técnicas del blog' },
      ],
    };
  }
  override async leerPagina(rutaOUrl: string) {
    if (rutaOUrl !== '/blog/agua-calderas') return { ok: false as const, error: 'La página no existe en el sitio.' };
    return { ok: true as const, url: 'https://grupoeytra.com/blog/agua-calderas', titulo: 'Agua de calderas', descripcion: '', texto: '# Agua de calderas', largo_total: 18 };
  }
}

let base = '';
let cerrar: () => void;
const asistente = new AsistenteFalso();

before(async () => {
  const config: Config = {
    urlPublica: 'http://127.0.0.1:0',
    recurso: '',
    puerto: 0,
    host: '127.0.0.1',
    hostsPermitidos: ['127.0.0.1', 'localhost'],
    sitio: 'https://grupoeytra.com',
    supabaseUrl: 'http://supabase.invalid',
    supabaseLlavePublicable: 'x',
    asistenteUrl: 'http://cms.invalid',
    asistenteLlave: 'x',
    secretoTokens: randomBytes(32).toString('hex'),
    rutaBase: ':memory:',
    encabezadoIp: null,
    hostsRedirect: ['claude.ai', 'claude.com'],
  };
  // El puerto se conoce al escuchar: se reserva uno y la app se crea con su URL definitiva.
  const { createServer } = await import('node:net');
  const puerto = await new Promise<number>((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });
  config.urlPublica = `http://127.0.0.1:${puerto}`;
  config.recurso = `${config.urlPublica}/mcp`;
  config.puerto = puerto;
  const { app } = crearApp(config, {
    almacen: new Almacen(':memory:'),
    asistente,
    login: new LoginFalso(),
    sitio: new SitioFalso('https://grupoeytra.com'),
    cms: cmsFalso,
  });
  const servidor = app.listen(puerto, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  base = config.urlPublica;
  cerrar = () => servidor.close();
});

after(() => cerrar());

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function registrar() {
  const r = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(r.status, 201);
  return ((await r.json()) as { client_id: string }).client_id;
}

const form = (datos: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(datos).toString(),
  redirect: 'manual' as const,
});

/** Recorre /authorize con el correo dado y devuelve la respuesta final (302 con código, o una página). */
async function autorizar(clientId: string, correo: string, opciones: { codigo2fa?: string; verificador: string }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: s256(opciones.verificador),
    code_challenge_method: 'S256',
    state: 'estado-1',
    scope: 'eytra',
    resource: `${base}/mcp`,
  });
  const pagina = await fetch(`${base}/authorize?${q}`);
  assert.equal(pagina.status, 200);
  const html = await pagina.text();
  assert.match(html, /Claude/);
  const tx = /name="tx" value="([^"]+)"/.exec(html)![1]!;
  let r = await fetch(`${base}/authorize`, form({ tx, paso: 'contrasena', correo, contrasena: 'bien' }));
  if (opciones.codigo2fa) {
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Código de verificación/);
    r = await fetch(`${base}/authorize`, form({ tx, paso: 'codigo', codigo: opciones.codigo2fa }));
  }
  return r;
}

async function tokenPara(correo: string, codigo2fa?: string) {
  const clientId = await registrar();
  const verificador = randomBytes(32).toString('base64url');
  const r = await autorizar(clientId, correo, { codigo2fa, verificador });
  assert.equal(r.status, 302);
  const destino = new URL(r.headers.get('location')!);
  assert.equal(`${destino.origin}${destino.pathname}`, REDIRECT);
  assert.equal(destino.searchParams.get('state'), 'estado-1');
  assert.equal(destino.searchParams.get('iss'), base);
  const t = await fetch(
    `${base}/token`,
    form({ grant_type: 'authorization_code', code: destino.searchParams.get('code')!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verificador, resource: `${base}/mcp` }),
  );
  assert.equal(t.status, 200);
  const cuerpo = (await t.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
  assert.equal(cuerpo.token_type, 'Bearer');
  return { ...cuerpo, clientId, codigo: destino.searchParams.get('code')!, verificador };
}

async function cliente(token?: string) {
  const c = new Client({ name: 'prueba', version: '1.0.0' });
  const transporte = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
  await c.connect(transporte);
  return c;
}

const textoDe = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

describe('descubrimiento', () => {
  test('metadatos del recurso y del servidor de autorización', async () => {
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    assert.equal(prm.resource, `${base}/mcp`);
    assert.deepEqual(prm.authorization_servers, [base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ['none']);
  });

  test('registro rechaza redirects fuera de claude.ai, claude.com y localhost', async () => {
    for (const uri of ['http://evil.example/cb', 'https://evil.example/cb', 'https://claude.ai.evil.example/cb', 'https://claude.ai:8443/cb']) {
      const r = await fetch(`${base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [uri] }) });
      assert.equal(r.status, 400, uri);
    }
  });

  test('authorize: los errores antes del login no redirigen a ningún lado', async () => {
    const clientId = await registrar();
    const sinPkce = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, state: 's' })}`, { redirect: 'manual' });
    assert.equal(sinPkce.status, 400);
    assert.equal(sinPkce.headers.get('location'), null);
    const desconocido = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'nadie', redirect_uri: REDIRECT })}`, { redirect: 'manual' });
    assert.equal(desconocido.status, 400);
    const otroRedirect = await fetch(`${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://evil.example/cb' })}`, { redirect: 'manual' });
    assert.equal(otroRedirect.status, 400);
  });
});

describe('sin sesión', () => {
  test('anuncia todo, responde lo público y pide sesión para lo privado', async () => {
    const c = await cliente();
    const nombres = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['buscar_en_sitio', 'leer_pagina', 'catalogo_de_productos', 'estado_de_cuenta', 'resumen_del_dia']) assert.ok(nombres.includes(n), n);
    assert.match(textoDe(await c.callTool({ name: 'buscar_en_sitio', arguments: { consulta: 'laboratorio' } })), /grupoeytra\.com\/laboratorio/);
    assert.match(textoDe(await c.callTool({ name: 'catalogo_de_productos', arguments: {} })), /cloro/);
    await c.callTool({ name: 'catalogo_de_productos', arguments: { orden: 'precio_asc', limite: 5 } });
    assert.deepEqual(cmsFalso.pedidos.at(-1), { buscar: undefined, orden: 'precio_asc', limite: 5 });
    // Blog: con el CMS vacío lista desde llms.txt y lee la página del sitio.
    const blog = JSON.parse(textoDe(await c.callTool({ name: 'articulos_del_blog', arguments: { buscar: 'calderas' } })));
    assert.deepEqual(blog.articulos, [{ slug: 'agua-calderas', title: 'Agua de calderas', excerpt: 'tratamiento interno', url: 'https://grupoeytra.com/blog/agua-calderas' }]);
    assert.match(textoDe(await c.callTool({ name: 'leer_articulo', arguments: { slug: 'agua-calderas' } })), /# Agua de calderas/);
    const sinArticulo = await c.callTool({ name: 'leer_articulo', arguments: { slug: 'no-existe' } });
    assert.equal(sinArticulo.isError, true);
    await c.callTool({ name: 'documentos', arguments: {} });
    assert.deepEqual(asistente.llamadas.at(-1), { metodo: 'GET', ruta: '/knowledge', usuario: undefined, cuerpo: undefined });
    await c.close();

    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estado_de_cuenta', arguments: {} } }),
    });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test('un token inválido siempre da 401 con invalid_token', async () => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer basura' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
  });
});

describe('con sesión', () => {
  test('cliente: ve sus herramientas, no las del equipo, y la API recibe su id', async () => {
    const { access_token } = await tokenPara('cliente@x.test');
    const c = await cliente(access_token);
    const nombres = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(nombres.includes('estado_de_cuenta'));
    assert.ok(nombres.includes('crear_solicitud'));
    assert.ok(!nombres.includes('resumen_del_dia'));
    assert.match(textoDe(await c.callTool({ name: 'estado_de_cuenta', arguments: {} })), /1740/);
    assert.deepEqual(asistente.llamadas.at(-1), { metodo: 'GET', ruta: '/account', usuario: 'u-cliente', cuerpo: undefined });
    await c.callTool({ name: 'crear_solicitud', arguments: { tipo: 'maintenance', titulo: 'Bomba', descripcion: 'Hace ruido' } });
    assert.deepEqual(asistente.llamadas.at(-1)?.cuerpo, { kind: 'maintenance', title: 'Bomba', description: 'Hace ruido' });
    await c.close();
  });

  test('equipo con segundo factor: solo el resumen del día', async () => {
    const { access_token } = await tokenPara('equipo@x.test', '123456');
    const c = await cliente(access_token);
    const nombres = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(nombres.includes('resumen_del_dia'));
    assert.ok(!nombres.includes('estado_de_cuenta'));
    assert.ok(nombres.includes('buscar_en_sitio'));
    assert.match(textoDe(await c.callTool({ name: 'resumen_del_dia', arguments: {} })), /billed/);
    await c.close();
  });

  test('segundo factor equivocado no entrega código', async () => {
    const clientId = await registrar();
    const r = await autorizar(clientId, 'equipo@x.test', { codigo2fa: '000000', verificador: randomBytes(32).toString('base64url') });
    assert.equal(r.status, 401);
    assert.match(await r.text(), /no es válido/);
  });

  test('Finanzas (doble factor obligatorio) no recibe código: la API lo rechaza', async () => {
    const clientId = await registrar();
    const r = await autorizar(clientId, 'finanzas@x.test', { verificador: randomBytes(32).toString('base64url') });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /doble factor obligatorio/);
  });

  test('el código es de un solo uso, exige el verificador PKCE y el refresh rota', async () => {
    const t = await tokenPara('cliente@x.test');
    const reuso = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code: t.codigo, client_id: t.clientId, redirect_uri: REDIRECT, code_verifier: t.verificador }));
    assert.equal(reuso.status, 400);

    const r1 = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }));
    assert.equal(r1.status, 200);
    const nuevo = (await r1.json()) as { refresh_token: string };
    assert.notEqual(nuevo.refresh_token, t.refresh_token);
    // Reusar el viejo revoca también el nuevo.
    assert.equal((await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }))).status, 400);
    assert.equal((await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: nuevo.refresh_token, client_id: t.clientId }))).status, 400);
  });

  test('PKCE: un verificador distinto no canjea el código', async () => {
    const clientId = await registrar();
    const verificador = randomBytes(32).toString('base64url');
    const r = await autorizar(clientId, 'cliente@x.test', { verificador });
    const code = new URL(r.headers.get('location')!).searchParams.get('code')!;
    const t = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString('base64url') }));
    assert.equal(t.status, 400);
  });
});
