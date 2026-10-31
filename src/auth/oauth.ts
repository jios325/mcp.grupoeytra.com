import { createHash } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';

import type { ClienteAsistente } from '../asistente.js';
import type { Config } from '../config.js';
import { aleatorio, type Almacen, type ClienteOAuth } from './almacen.js';
import type { LoginSupabase } from './login.js';
import { paginaCodigo, paginaError, paginaLogin } from './paginas.js';
import { Limitador } from './limitador.js';
import { DURACION_ACCESS_S, DURACION_REFRESH_MS, SCOPE, type Tokens } from './tokens.js';

// Servidor de autorización OAuth 2.1 mínimo para clientes MCP (Claude, Claude Code, otros):
// metadatos RFC 8414 y RFC 9728, registro dinámico (RFC 7591), código con PKCE S256 obligatorio,
// refresh tokens con rotación y revocación (RFC 7009). El usuario se identifica con su cuenta del CMS
// (Supabase Auth); el permiso real lo decide la API del asistente con RLS en cada llamada.

const DURACION_TX_MS = 10 * 60_000;
const DURACION_CODIGO_MS = 60_000;
const MAX_INTENTOS_TX = 5;
const MAX_TRANSACCIONES = 2_000;

interface Transaccion {
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  vence: number;
  intentos: number;
  correo?: string;
  segundoFactor?: { sesion: { access_token: string; refresh_token: string }; factorId: string };
}

export interface DependenciasOAuth {
  config: Config;
  almacen: Almacen;
  tokens: Tokens;
  login: LoginSupabase;
  asistente: ClienteAsistente;
}

const esLoopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

/**
 * https solo en los hosts de confianza (por omisión claude.ai, claude.com y chatgpt.com, MCP_REDIRECT_HOSTS), o http en
 * loopback (Claude Code abre un puerto local). Sin la lista, cualquiera podría registrar un cliente
 * llamado «Claude» que mande el código a su propio servidor y pedir a una víctima que inicie sesión.
 */
export function redirectValido(uri: string, hostsPermitidos: readonly string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return url.port === '' && hostsPermitidos.includes(url.hostname.toLowerCase());
  return url.protocol === 'http:' && esLoopback(url.hostname);
}

/** Igual a uno registrado; en loopback se ignora el puerto (RFC 8252 §7.3). */
export function redirectRegistrado(cliente: ClienteOAuth, uri: string): boolean {
  if (cliente.redirect_uris.includes(uri)) return true;
  let pedido: URL;
  try {
    pedido = new URL(uri);
  } catch {
    return false;
  }
  if (pedido.protocol !== 'http:' || !esLoopback(pedido.hostname)) return false;
  return cliente.redirect_uris.some((r) => {
    const registrado = new URL(r);
    return registrado.protocol === 'http:' && registrado.hostname === pedido.hostname && registrado.pathname === pedido.pathname && registrado.search === pedido.search;
  });
}

export const s256 = (verificador: string) => createHash('sha256').update(verificador).digest('base64url');

const recursoValido = (pedido: unknown, recurso: string) =>
  pedido === undefined || pedido === '' || (typeof pedido === 'string' && pedido.replace(/\/+$/, '') === recurso);

function texto(valor: unknown, max = 2048): string | null {
  return typeof valor === 'string' && valor.length > 0 && valor.length <= max ? valor : null;
}

export function ipDe(req: Request, config: Config): string {
  if (config.encabezadoIp) {
    const valor = req.headers[config.encabezadoIp];
    const ip = (Array.isArray(valor) ? valor[0] : valor)?.split(',').at(-1)?.trim();
    if (ip) return ip;
  }
  return req.socket.remoteAddress ?? 'desconocida';
}

export function rutasOAuth(dep: DependenciasOAuth): Router {
  const { config, almacen, tokens, login, asistente } = dep;
  const router = express.Router();
  const transacciones = new Map<string, Transaccion>();
  const limiteLogin = new Limitador(20, 15 * 60_000);
  const limiteAutorizar = new Limitador(60, 15 * 60_000);
  // Por cuenta solo cuentan los fallos: un tercero no puede bloquear a alguien con intentos en blanco.
  const fallosCorreo = new Limitador(10, 15 * 60_000);
  const fallosCodigo = new Limitador(5, 15 * 60_000);
  const limiteRegistro = new Limitador(20, 60 * 60_000);
  const limiteToken = new Limitador(120, 60 * 60_000);

  setInterval(() => {
    const ahora = Date.now();
    for (const [id, tx] of transacciones) {
      if (tx.vence < ahora) {
        transacciones.delete(id);
        if (tx.segundoFactor) void login.descartar(tx.segundoFactor.sesion).catch(() => undefined);
      }
    }
  }, 60_000).unref();

  const metadatosRecurso = {
    resource: config.recurso,
    authorization_servers: [config.urlPublica],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Grupo Eytra',
    resource_documentation: `${config.urlPublica}/`,
  };

  // RFC 9728: Claude prueba primero la variante con la ruta del recurso y luego la raíz.
  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(metadatosRecurso);
  });

  router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({
      issuer: config.urlPublica,
      authorization_endpoint: `${config.urlPublica}/authorize`,
      token_endpoint: `${config.urlPublica}/token`,
      registration_endpoint: `${config.urlPublica}/register`,
      revocation_endpoint: `${config.urlPublica}/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${config.urlPublica}/`,
    });
  });

  // RFC 7591. Solo clientes públicos (sin secreto) con PKCE.
  router.post('/register', (req, res) => {
    if (!limiteRegistro.tomar(ipDe(req, config))) {
      res.status(429).set('Retry-After', '3600').json({ error: 'invalid_client_metadata', error_description: 'Demasiados registros desde esta dirección.' });
      return;
    }
    const cuerpo = (req.body ?? {}) as Record<string, unknown>;
    const uris = Array.isArray(cuerpo.redirect_uris) ? cuerpo.redirect_uris : [];
    if (uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === 'string' && u.length <= 512 && redirectValido(u, config.hostsRedirect))) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: `redirect_uris debe traer de 1 a 10 URLs https de ${config.hostsRedirect.join(', ')} o http en localhost.`,
      });
      return;
    }
    const tipos = cuerpo.grant_types;
    if (tipos !== undefined && (!Array.isArray(tipos) || !tipos.every((t) => t === 'authorization_code' || t === 'refresh_token'))) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Solo se admiten authorization_code y refresh_token.' });
      return;
    }
    const nombre = (typeof cuerpo.client_name === 'string' ? cuerpo.client_name : 'Aplicación MCP').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Aplicación MCP';
    const cliente = almacen.registrarCliente({ client_name: nombre, redirect_uris: uris as string[] });
    if (!cliente) {
      res.status(503).json({ error: 'temporarily_unavailable', error_description: 'No se pueden registrar más aplicaciones por ahora.' });
      return;
    }
    res.status(201).set('Cache-Control', 'no-store').json({
      client_id: cliente.client_id,
      client_id_issued_at: Math.floor(cliente.creado / 1000),
      client_name: cliente.client_name,
      redirect_uris: cliente.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    });
  });

  const html = (res: Response, status: number, cuerpo: string) => {
    res
      .status(status)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Frame-Options': 'DENY',
        // Sin form-action: Chrome la aplica también al 302 que sigue al POST y bloquearía el regreso a Claude.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer',
      })
      .send(cuerpo);
  };

  const redirigir = (res: Response, uri: string, parametros: Record<string, string | null>) => {
    const url = new URL(uri);
    for (const [clave, valor] of Object.entries(parametros)) if (valor !== null) url.searchParams.set(clave, valor);
    url.searchParams.set('iss', config.urlPublica);
    res.set('Cache-Control', 'no-store').redirect(302, url.toString());
  };

  const destinoVisible = (uri: string) => {
    const url = new URL(uri);
    return esLoopback(url.hostname) ? 'la aplicación en su computadora' : url.host;
  };

  router.get('/authorize', (req, res) => {
    if (!limiteAutorizar.tomar(ipDe(req, config))) return html(res, 429, paginaError('Demasiadas solicitudes', 'Espere 15 minutos antes de volver a intentar.'));
    const q = req.query as Record<string, unknown>;
    const clientId = texto(q.client_id, 200);
    const redirectUri = texto(q.redirect_uri);
    const cliente = clientId ? almacen.cliente(clientId) : null;
    // Antes del login ningún error redirige (RFC 9700 §4.11.2): sin redirecciones abiertas desde este dominio.
    if (!cliente) return html(res, 400, paginaError('Aplicación desconocida', 'La aplicación que le trajo aquí no está registrada. Vuelva a agregar el conector.'));
    if (!redirectUri || !redirectRegistrado(cliente, redirectUri) || !redirectValido(redirectUri, config.hostsRedirect)) {
      return html(res, 400, paginaError('Dirección de regreso inválida', 'La aplicación pidió volver a una dirección que no está permitida.'));
    }
    const invalida = (detalle: string) => html(res, 400, paginaError('Solicitud inválida', `${detalle} Vuelva a conectar desde su aplicación.`));
    if (q.response_type !== 'code') return invalida('Tipo de respuesta no admitido.');
    const challenge = texto(q.code_challenge, 128);
    if (!challenge || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return invalida('Falta PKCE con S256.');
    if (!recursoValido(q.resource, config.recurso)) return invalida('El recurso pedido no es este servidor.');
    const scopes = typeof q.scope === 'string' ? q.scope.split(' ').filter(Boolean) : [SCOPE];
    if (scopes.some((s) => s !== SCOPE)) return invalida('Permiso (scope) desconocido.');
    if (transacciones.size >= MAX_TRANSACCIONES) return html(res, 503, paginaError('Servicio ocupado', 'Hay demasiados inicios de sesión en curso. Intente en unos minutos.'));

    const tx = aleatorio(24);
    transacciones.set(tx, {
      clientId: cliente.client_id,
      clientName: cliente.client_name,
      redirectUri,
      state: texto(q.state, 512),
      codeChallenge: challenge,
      scope: SCOPE,
      vence: Date.now() + DURACION_TX_MS,
      intentos: 0,
    });
    html(res, 200, paginaLogin({ tx, cliente: cliente.client_name, destino: destinoVisible(redirectUri) }));
  });

  router.post('/authorize', async (req, res) => {
    const cuerpo = (req.body ?? {}) as Record<string, unknown>;
    const id = texto(cuerpo.tx, 64);
    const tx = id ? transacciones.get(id) : undefined;
    if (!id || !tx || tx.vence < Date.now()) {
      return html(res, 400, paginaError('La solicitud venció', 'Pasaron más de 10 minutos o la página ya se usó.'));
    }
    const comun = { tx: id, cliente: tx.clientName, destino: destinoVisible(tx.redirectUri) };
    if (!limiteLogin.tomar(ipDe(req, config))) {
      return html(res, 429, paginaError('Demasiados intentos', 'Espere 15 minutos antes de volver a intentar.'));
    }
    tx.intentos += 1;
    if (tx.intentos > MAX_INTENTOS_TX * 2) {
      transacciones.delete(id);
      return html(res, 429, paginaError('Demasiados intentos', 'Vuelva a conectar desde su aplicación.'));
    }

    let resultado;
    if (cuerpo.paso === 'codigo' && tx.segundoFactor && tx.correo) {
      const codigo = texto(cuerpo.codigo, 6);
      if (!codigo || !/^\d{6}$/.test(codigo)) return html(res, 400, paginaCodigo({ ...comun, error: 'El código tiene 6 dígitos.' }));
      // Tope por cuenta (no solo por IP): quien ya tiene la contraseña no puede probar códigos sin fin.
      if (fallosCodigo.excedido(tx.correo)) return html(res, 429, paginaCodigo({ ...comun, error: 'Demasiados códigos incorrectos. Espere 15 minutos.' }));
      resultado = await login.conCodigo(tx.segundoFactor.sesion, tx.segundoFactor.factorId, codigo);
      if (resultado.tipo === 'error') {
        fallosCodigo.sumar(tx.correo);
        return html(res, 401, paginaCodigo({ ...comun, error: resultado.mensaje }));
      }
    } else {
      const correo = texto(cuerpo.correo, 254)?.trim().toLowerCase() ?? null;
      const contrasena = texto(cuerpo.contrasena, 200);
      if (!correo || !contrasena) return html(res, 400, paginaLogin({ ...comun, error: 'Escriba su correo y su contraseña.', correo: correo ?? '' }));
      if (fallosCorreo.excedido(correo)) return html(res, 429, paginaLogin({ ...comun, error: 'Demasiados intentos con este correo. Espere 15 minutos.', correo }));
      resultado = await login.conContrasena(correo, contrasena);
      if (resultado.tipo === 'error') {
        fallosCorreo.sumar(correo);
        return html(res, 401, paginaLogin({ ...comun, error: resultado.mensaje, correo }));
      }
      if (resultado.tipo === 'segundo_factor') {
        tx.segundoFactor = { sesion: resultado.sesion, factorId: resultado.factorId };
        tx.correo = correo;
        return html(res, 200, paginaCodigo(comun));
      }
    }
    if (resultado.tipo !== 'listo') return html(res, 400, paginaError('No se pudo iniciar sesión', 'Vuelva a conectar desde su aplicación.'));

    // La persona existe en Auth; ahora la API dice si puede usar el asistente (activa, no comprador, sin
    // doble factor obligatorio por rol) y con qué alcance. Su mensaje se muestra tal cual.
    const persona = await asistente.persona(resultado.usuarioId);
    transacciones.delete(id);
    if (!persona.ok) {
      console.warn('[oauth] inicio rechazado por la API', { status: persona.status, cliente: tx.clientId });
      if (persona.status === 403 || persona.status === 404) return html(res, 403, paginaError('Acceso no disponible', persona.error));
      return html(res, 503, paginaError('Servicio no disponible', 'No pudimos confirmar su cuenta en este momento. Intente de nuevo en unos minutos.'));
    }

    const codigo = aleatorio(32);
    almacen.guardarCodigo(codigo, {
      client_id: tx.clientId,
      usuario_id: resultado.usuarioId,
      redirect_uri: tx.redirectUri,
      code_challenge: tx.codeChallenge,
      scope: tx.scope,
      vence: Date.now() + DURACION_CODIGO_MS,
    });
    console.info('[oauth] sesión iniciada', { usuario: resultado.usuarioId, alcance: persona.data.user.scope, cliente: tx.clientId });
    redirigir(res, tx.redirectUri, { code: codigo, state: tx.state });
  });

  const errorToken = (res: Response, status: number, error: string, descripcion: string) =>
    res.status(status).set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json({ error, error_description: descripcion });

  router.post('/token', async (req, res) => {
    if (!limiteToken.tomar(ipDe(req, config))) return errorToken(res, 429, 'slow_down', 'Demasiadas solicitudes.');
    const p = (req.body ?? {}) as Record<string, unknown>;
    const clientId = texto(p.client_id, 200);
    const cliente = clientId ? almacen.cliente(clientId) : null;
    if (!cliente) return errorToken(res, 401, 'invalid_client', 'Cliente desconocido.');
    if (!recursoValido(p.resource, config.recurso)) return errorToken(res, 400, 'invalid_target', 'El recurso no es este servidor.');

    let usuarioId: string;
    let familia: string;
    if (p.grant_type === 'authorization_code') {
      const codigo = texto(p.code, 200);
      const verificador = texto(p.code_verifier, 128);
      const datos = codigo ? almacen.canjearCodigo(codigo) : null;
      if (!datos || !verificador || datos.client_id !== cliente.client_id || datos.redirect_uri !== p.redirect_uri || s256(verificador) !== datos.code_challenge) {
        return errorToken(res, 400, 'invalid_grant', 'El código no es válido, ya se usó o venció.');
      }
      usuarioId = datos.usuario_id;
      familia = aleatorio(16);
    } else if (p.grant_type === 'refresh_token') {
      const token = texto(p.refresh_token, 200);
      const sinSesion = () => errorToken(res, 400, 'invalid_grant', 'La sesión venció o fue revocada. Vuelva a iniciar sesión.');
      const visto = token ? almacen.verRefresh(token) : null;
      if (!token || !visto || visto.client_id !== cliente.client_id) return sinSesion();
      // Cada renovación confirma con la API que la persona sigue activa y con acceso, antes de gastar el
      // refresh: solo 403/404 cierra la sesión; un 429 o una caída de la API deja el token para reintentar.
      const persona = await asistente.persona(visto.usuario_id);
      if (!persona.ok) {
        if (persona.status === 403 || persona.status === 404) {
          almacen.revocarFamilia(visto.familia);
          return errorToken(res, 400, 'invalid_grant', persona.error);
        }
        res.set('Retry-After', '60');
        return errorToken(res, 503, 'temporarily_unavailable', 'Intente de nuevo en un minuto.');
      }
      const uso = almacen.usarRefresh(token);
      if (!uso.ok) {
        if (uso.motivo === 'reusado') console.warn('[oauth] refresh token reusado: familia revocada', { cliente: cliente.client_id });
        return sinSesion();
      }
      usuarioId = uso.datos.usuario_id;
      familia = uso.datos.familia;
    } else {
      return errorToken(res, 400, 'unsupported_grant_type', 'Solo authorization_code y refresh_token.');
    }

    const accessToken = await tokens.firmar(usuarioId, cliente.client_id, SCOPE);
    const refreshToken = almacen.emitirRefresh({ familia, client_id: cliente.client_id, usuario_id: usuarioId, scope: SCOPE, vence: Date.now() + DURACION_REFRESH_MS });
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: DURACION_ACCESS_S,
      refresh_token: refreshToken,
      scope: SCOPE,
    });
  });

  // RFC 7009: siempre 200, exista o no el token. Un access token no se puede revocar (dura 1 hora).
  router.post('/revoke', (req, res) => {
    const token = texto((req.body as Record<string, unknown> | undefined)?.token, 200);
    if (token) almacen.revocarRefresh(token);
    res.status(200).set('Cache-Control', 'no-store').end();
  });

  return router;
}
