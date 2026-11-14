import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import * as apoyo from './apoyo.js';
import { form, REDIRECT, type AppDePrueba, type AsistenteFalso, type CmsFalso } from './apoyo.js';

// Flujo completo contra la app real con el CMS y Supabase falsos (test/apoyo.ts): descubrimiento OAuth,
// registro, login (con y sin segundo factor), token, lazy auth, alcance por rol y rotación del refresh token.

let app: AppDePrueba;
let base = '';
let asistente: AsistenteFalso;
let cmsFalso: CmsFalso;

before(async () => {
  app = await apoyo.levantar();
  ({ base, asistente, cms: cmsFalso } = app);
});

after(() => app.cerrar());

const registrar = () => apoyo.registrar(base);
const autorizar = (clientId: string, correo: string, opciones: { codigo2fa?: string; verificador: string }) => apoyo.autorizar(base, clientId, correo, opciones);
const tokenPara = (correo: string, codigo2fa?: string) => apoyo.tokenPara(base, correo, codigo2fa);

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
    assert.deepEqual(asistente.llamadas.at(-1), { metodo: 'GET', ruta: '/knowledge', usuario: undefined, aal: 'aal1', cuerpo: undefined });
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
    assert.deepEqual(asistente.llamadas.at(-1), { metodo: 'GET', ruta: '/account', usuario: 'u-cliente', aal: 'aal1', cuerpo: undefined });
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

  test('Super Admin con su app de autenticación: cotiza y la API recibe aal2, también tras renovar', async () => {
    const t = await tokenPara('root@x.test', '123456');
    const c = await cliente(t.access_token);
    const nombres = (await c.listTools()).tools.map((x) => x.name);
    for (const n of ['crear_cotizacion', 'estado_de_cotizacion', 'resumen_del_dia']) assert.ok(nombres.includes(n), n);
    assert.ok(!nombres.includes('estado_de_cuenta'));
    const r = await c.callTool({
      name: 'crear_cotizacion',
      arguments: {
        cliente: { nombre: 'Carla Pérez', empresa: 'Hotel Nuevo', correo: 'carla@hotelnuevo.test', ciudad: 'Tulum' },
        partidas: [{ producto: 'cloro', cantidad: 2 }, { descripcion: 'Análisis fisicoquímico NOM-127', cantidad: 1, unidad: 'Mtra.' }],
        notas: 'Entrega antes del viernes.',
      },
    });
    assert.match(textoDe(r), /ET-1/);
    const llamada = asistente.llamadas.at(-1)!;
    assert.deepEqual({ ruta: llamada.ruta, usuario: llamada.usuario, aal: llamada.aal }, { ruta: '/quotes', usuario: 'u-root', aal: 'aal2' });
    const cuerpo = llamada.cuerpo as { client: unknown; lines: unknown; notes: string; source: { message_id: string } };
    assert.deepEqual(cuerpo.client, { name: 'Carla Pérez', company: 'Hotel Nuevo', email: 'carla@hotelnuevo.test', city: 'Tulum' });
    assert.deepEqual(cuerpo.lines, [{ slug: 'cloro', quantity: 2 }, { description: 'Análisis fisicoquímico NOM-127', quantity: 1, unit: 'Mtra.' }]);
    assert.match(cuerpo.source.message_id, /^mcp:[0-9a-f-]{36}$/);
    assert.match(textoDe(await c.callTool({ name: 'estado_de_cotizacion', arguments: { folio: 'ET-1' } })), /draft/);
    const sinContacto = await c.callTool({ name: 'crear_cotizacion', arguments: { cliente: { nombre: 'X' }, partidas: [{ descripcion: 'Visita', cantidad: 1 }] } });
    assert.equal(sinContacto.isError, true);
    await c.close();

    // Renovar conserva el doble factor del inicio de sesión.
    const r1 = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }));
    assert.equal(r1.status, 200);
    const c2 = await cliente(((await r1.json()) as { access_token: string }).access_token);
    assert.ok((await c2.listTools()).tools.some((x) => x.name === 'crear_cotizacion'));
    await c2.close();
  });

  test('Super Admin sin segundo factor no recibe código: la API lo rechaza', async () => {
    const clientId = await registrar();
    const r = await autorizar(clientId, 'rootsin@x.test', { verificador: randomBytes(32).toString('base64url') });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /doble factor obligatorio/);
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
