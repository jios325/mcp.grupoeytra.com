import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { ClienteAsistente, type Aal, type Persona, type Resultado } from '../src/asistente.js';
import { Almacen } from '../src/auth/almacen.js';
import { LoginSupabase, type PasoLogin } from '../src/auth/login.js';
import { s256 } from '../src/auth/oauth.js';
import type { Config } from '../src/config.js';
import { CmsPublico } from '../src/publico/cms.js';
import { Sitio } from '../src/publico/sitio.js';
import { crearApp } from '../src/servidor.js';

// Dobles del CMS, de Supabase y del sitio, y una app real levantada con ellos. Cada llamada a
// levantar() da una app aparte (límites y transacciones propios), para que una prueba no gaste los de otra.

export const PERSONAS: Record<string, Resultado<Persona>> = {
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

// Super Admin: como la API con la llave del MCP marcada, entra solo con aal2.
export const SUPER_ADMIN: Resultado<Persona> = {
  ok: true,
  data: { user: { id: 'u-root', name: 'Root', email: 'root@x.test', scope: 'staff', role: 'super_admin' }, company: null, tools: ['daily_summary', 'create_quote', 'quote_status'] },
};

export class AsistenteFalso extends ClienteAsistente {
  llamadas: { metodo: string; ruta: string; usuario?: string; aal?: Aal; cuerpo?: unknown }[] = [];
  /** Mientras haya compuerta, /me espera a que se abra: sirve para alinear peticiones simultáneas. */
  compuerta: Promise<void> | null = null;
  enEspera = 0;

  constructor() {
    super({ asistenteUrl: 'http://cms.invalid', asistenteLlave: 'x' });
  }

  override async llamar<T>(metodo: 'GET' | 'POST', ruta: string, op: { usuario?: string; aal?: Aal; cuerpo?: unknown } = {}): Promise<Resultado<T>> {
    this.llamadas.push({ metodo, ruta, usuario: op.usuario, aal: op.aal, cuerpo: op.cuerpo });
    if (ruta === '/me' && this.compuerta) {
      this.enEspera += 1;
      await this.compuerta;
    }
    if (op.usuario === 'u-root') {
      if (op.aal !== 'aal2') return { ok: false, status: 403, error: 'Las cuentas con doble factor obligatorio no usan el asistente.' };
      if (ruta === '/me') return SUPER_ADMIN as Resultado<T>;
      if (ruta === '/quotes') return { ok: true, data: { folio: 'ET-1', status: 'draft' } as T };
      if (ruta === '/quotes/ET-1') return { ok: true, data: { folio: 'ET-1', status: 'draft' } as T };
    }
    if (ruta === '/me') return (PERSONAS[op.usuario ?? ''] ?? { ok: false, status: 404, error: 'Usuario no registrado en el CMS.' }) as Resultado<T>;
    if (ruta === '/catalog') return { ok: true, data: { products: [{ slug: 'cloro', price: 100 }] } as T };
    if (ruta === '/account') return { ok: true, data: { company: 'Condominio Brisa', total_due: 1740 } as T };
    if (ruta === '/summary') return { ok: true, data: { billed: 1 } as T };
    if (ruta === '/requests') return { ok: true, data: { folio: 'SOL-1' } as T };
    return { ok: false, status: 404, error: 'no' };
  }

  rutas(ruta: string) {
    return this.llamadas.filter((l) => l.ruta === ruta || l.ruta.startsWith(`${ruta}/`));
  }
}

export class LoginFalso extends LoginSupabase {
  /** Espera antes de responder, como una ida a Supabase: deja ver qué pasa con intentos simultáneos. */
  retardoMs = 0;
  contrasenas = 0;
  codigos = 0;

  constructor() {
    super({ supabaseUrl: 'http://supabase.invalid', supabaseLlavePublicable: 'x' });
  }

  private async esperar() {
    if (this.retardoMs > 0) await new Promise((ok) => setTimeout(ok, this.retardoMs));
  }

  override async conContrasena(correo: string, contrasena: string): Promise<PasoLogin> {
    this.contrasenas += 1;
    await this.esperar();
    if (contrasena !== 'bien') return { tipo: 'error', mensaje: 'Correo o contraseña incorrectos.' };
    if (correo === 'equipo@x.test') return { tipo: 'segundo_factor', sesion: { access_token: 'a', refresh_token: 'r' }, factorId: 'f' };
    if (correo === 'root@x.test') return { tipo: 'segundo_factor', sesion: { access_token: 'a-root', refresh_token: 'r' }, factorId: 'f' };
    // Super Admin sin app de autenticación dada de alta: entra solo con contraseña (aal1).
    const ids: Record<string, string> = { 'cliente@x.test': 'u-cliente', 'finanzas@x.test': 'u-finanzas', 'rootsin@x.test': 'u-root' };
    return ids[correo] ? { tipo: 'listo', usuarioId: ids[correo]!, aal: 'aal1' } : { tipo: 'error', mensaje: 'Correo o contraseña incorrectos.' };
  }

  override async conCodigo(s: { access_token: string }, _f: string, codigo: string): Promise<PasoLogin> {
    this.codigos += 1;
    await this.esperar();
    return codigo === '123456' ? { tipo: 'listo', usuarioId: s.access_token === 'a-root' ? 'u-root' : 'u-equipo', aal: 'aal2' } : { tipo: 'error', mensaje: 'El código no es válido.' };
  }

  override async descartar() {}
}

export class CmsFalso extends CmsPublico {
  pedidos: Parameters<CmsPublico['catalogo']>[0][] = [];

  constructor() {
    super({ supabaseUrl: 'http://supabase.invalid', supabaseLlavePublicable: 'x' });
  }

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

export class SitioFalso extends Sitio {
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

export interface AppDePrueba {
  base: string;
  asistente: AsistenteFalso;
  login: LoginFalso;
  cms: CmsFalso;
  almacen: Almacen;
  cerrar: () => void;
}

export async function levantar(opciones: { encabezadoIp?: string | null; recurso?: string } = {}): Promise<AppDePrueba> {
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
    encabezadoIp: opciones.encabezadoIp ?? null,
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
  // `recurso` permite probar lo que depende de la URL pública del conector (el origen de las vistas en Claude).
  config.recurso = opciones.recurso ?? `${config.urlPublica}/mcp`;
  config.puerto = puerto;
  const asistente = new AsistenteFalso();
  const login = new LoginFalso();
  const cms = new CmsFalso();
  const almacen = new Almacen(':memory:');
  const { app } = crearApp(config, { almacen, asistente, login, sitio: new SitioFalso('https://grupoeytra.com'), cms });
  const servidor = app.listen(puerto, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  return {
    base: config.urlPublica,
    asistente,
    login,
    cms,
    almacen,
    cerrar: () => {
      servidor.closeAllConnections();
      servidor.close();
    },
  };
}

export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

export async function registrar(base: string) {
  const r = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(r.status, 201);
  return ((await r.json()) as { client_id: string }).client_id;
}

export const form = (datos: Record<string, string>, encabezados: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...encabezados },
  body: new URLSearchParams(datos).toString(),
  redirect: 'manual' as const,
});

/** Abre /authorize y devuelve el id de la transacción de login (el campo oculto del formulario). */
export async function abrirLogin(base: string, clientId: string, verificador: string) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: s256(verificador),
    code_challenge_method: 'S256',
    state: 'estado-1',
    scope: 'eytra',
    resource: `${base}/mcp`,
  });
  const pagina = await fetch(`${base}/authorize?${q}`);
  assert.equal(pagina.status, 200);
  const html = await pagina.text();
  assert.match(html, /Claude/);
  return /name="tx" value="([^"]+)"/.exec(html)![1]!;
}

/** Recorre /authorize con el correo dado y devuelve la respuesta final (302 con código, o una página). */
export async function autorizar(base: string, clientId: string, correo: string, opciones: { codigo2fa?: string; verificador: string }) {
  const tx = await abrirLogin(base, clientId, opciones.verificador);
  let r = await fetch(`${base}/authorize`, form({ tx, paso: 'contrasena', correo, contrasena: 'bien' }));
  if (opciones.codigo2fa) {
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Código de verificación/);
    r = await fetch(`${base}/authorize`, form({ tx, paso: 'codigo', codigo: opciones.codigo2fa }));
  }
  return r;
}

export async function tokenPara(base: string, correo: string, codigo2fa?: string) {
  const clientId = await registrar(base);
  const verificador = randomBytes(32).toString('base64url');
  const r = await autorizar(base, clientId, correo, { codigo2fa, verificador });
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

/** POST /mcp con JSON-RPC a mano (sin el cliente del SDK), para controlar encabezados y lotes. */
export function rpc(base: string, cuerpo: unknown, encabezados: Record<string, string> = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...encabezados },
    body: JSON.stringify(cuerpo),
  });
}

export const llamada = (id: number, nombre: string, argumentos: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: nombre, arguments: argumentos } });
