import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import express, { type NextFunction, type Request, type Response } from 'express';

import { ClienteAsistente, type Persona, type Resultado } from './asistente.js';
import { Almacen } from './auth/almacen.js';
import { Limitador } from './auth/limitador.js';
import { LoginSupabase } from './auth/login.js';
import { ipDe, rutasOAuth } from './auth/oauth.js';
import { SCOPE, Tokens } from './auth/tokens.js';
import type { Config } from './config.js';
import { crearServidor, esProtegida, PROTEGIDAS, VERSION } from './herramientas.js';
import { CmsPublico } from './publico/cms.js';
import { Sitio } from './publico/sitio.js';

// Ensambla la app: OAuth (metadatos, registro, login, token), el endpoint MCP con autenticación
// perezosa y las páginas de apoyo. Se exporta sin escuchar para poder probarla.

export interface Piezas {
  almacen?: Almacen;
  asistente?: ClienteAsistente;
  login?: LoginSupabase;
  sitio?: Sitio;
  cms?: CmsPublico;
}

const TTL_PERSONA_MS = 60_000;

export function crearApp(config: Config, piezas: Piezas = {}) {
  const almacen = piezas.almacen ?? new Almacen(config.rutaBase);
  const asistente = piezas.asistente ?? new ClienteAsistente(config);
  const login = piezas.login ?? new LoginSupabase(config);
  const sitio = piezas.sitio ?? new Sitio(config.sitio);
  const cms = piezas.cms ?? new CmsPublico(config);
  const tokens = new Tokens(config.secretoTokens, config.urlPublica, config.recurso);
  const metadatosRecurso = `${config.urlPublica}/.well-known/oauth-protected-resource/mcp`;
  // Visitantes: tope por IP de llamadas a herramientas y cupo global de llamadas a la API (la llave del
  // MCP tiene 600 por hora en la API para todos; así quedan al menos 450 para quienes tienen sesión).
  const limiteVisitante = new Limitador(120, 15 * 60_000);
  const cupoVisitantes = new Limitador(150, 60 * 60_000);

  setInterval(() => almacen.limpiar(), 60 * 60_000).unref();

  // /me de cada persona con sesión, un minuto en memoria (cada mensaje de MCP es una petición HTTP).
  const personas = new Map<string, { resultado: Resultado<Persona>; vence: number }>();
  async function persona(usuarioId: string): Promise<Resultado<Persona>> {
    const guardada = personas.get(usuarioId);
    if (guardada && guardada.vence > Date.now()) return guardada.resultado;
    const resultado = await asistente.persona(usuarioId);
    if (resultado.ok || resultado.status === 403 || resultado.status === 404) personas.set(usuarioId, { resultado, vence: Date.now() + TTL_PERSONA_MS });
    if (personas.size > 5_000) personas.clear();
    return resultado;
  }

  const mcp = createMcpHandler(
    async (ctx) => {
      const usuarioId = typeof ctx.authInfo?.extra?.usuarioId === 'string' ? ctx.authInfo.extra.usuarioId : null;
      return crearServidor({ sitio, cms, asistente, cupoVisitantes }, { usuarioId, persona: usuarioId ? await persona(usuarioId) : null });
    },
    { onerror: (error) => console.error('[mcp]', error.message) },
  );
  const mcpNodo = toNodeHandler(mcp, { onerror: (error) => console.error('[mcp] adaptador', error.message) });

  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.hostsPermitidos, jsonLimit: '256kb' });
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));

  // Los clientes MCP en navegador (p. ej. el Inspector) necesitan CORS. Sin cookies: el acceso va
  // siempre en el encabezado Authorization, así que «*» no expone nada.
  app.use(['/mcp', '/.well-known', '/register', '/token', '/revoke'], (req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version',
    });
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(rutasOAuth({ config, almacen, tokens, login, asistente }));

  const desafio = (res: Response, error?: 'invalid_token', descripcion?: string) => {
    const partes = [`resource_metadata="${metadatosRecurso}"`, `scope="${SCOPE}"`];
    if (error) partes.unshift(`error="${error}"`, `error_description="${descripcion ?? 'Inicie sesión de nuevo.'}"`);
    res
      .status(401)
      .set('WWW-Authenticate', `Bearer ${partes.join(', ')}`)
      .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Inicie sesión con su cuenta de Grupo Eytra para usar esta herramienta.' } });
  };

  // Autenticación perezosa: lo público pasa sin token; una llamada a herramienta privada sin token
  // recibe 401 con WWW-Authenticate (así Claude muestra «Conectar»). Un token presente pero inválido o
  // vencido siempre da 401, para que el cliente lo renueve.
  async function puerta(req: Request, res: Response, next: NextFunction) {
    const encabezado = req.headers.authorization;
    if (encabezado) {
      const coincide = /^Bearer\s+(\S+)\s*$/i.exec(encabezado);
      const sujeto = coincide ? await tokens.verificar(coincide[1]!) : null;
      if (!sujeto) return desafio(res, 'invalid_token', 'El acceso venció o no es válido.');
      const auth: AuthInfo = {
        token: coincide![1]!,
        clientId: sujeto.clientId,
        scopes: sujeto.scope.split(' ').filter(Boolean),
        expiresAt: sujeto.vence,
        resource: new URL(config.recurso),
        resourceMetadataUrl: metadatosRecurso,
        extra: { usuarioId: sujeto.usuarioId },
      };
      (req as Request & { auth?: AuthInfo }).auth = auth;
      return next();
    }
    const mensajes = Array.isArray(req.body) ? req.body : [req.body];
    const pidePrivada = mensajes.some((m) => m && typeof m === 'object' && m.method === 'tools/call' && esProtegida(m.params?.name));
    if (pidePrivada) return desafio(res);
    const llamadas = mensajes.filter((m) => m && typeof m === 'object' && m.method === 'tools/call').length;
    for (let i = 0; i < llamadas; i++) {
      if (!limiteVisitante.tomar(ipDe(req, config))) {
        res.status(429).set('Retry-After', '900').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Demasiadas consultas. Espere unos minutos o inicie sesión.' } });
        return;
      }
    }
    next();
  }

  app.all('/mcp', puerta, (req, res) => void mcpNodo(req, res, req.body));

  app.get('/salud', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, version: VERSION });
  });

  app.get('/', (_req, res) => {
    res.type('text/plain; charset=utf-8').send(
      [
        `Grupo Eytra · servidor MCP ${VERSION}`,
        '',
        `Conéctelo en Claude (Configuración › Conectores › Agregar conector personalizado) con esta URL:`,
        `  ${config.recurso}`,
        '',
        'Sin iniciar sesión: información pública del sitio, catálogo, blog y políticas de la tienda.',
        `Con su cuenta del portal o del CMS: ${Object.keys(PROTEGIDAS).join(', ')} (según su rol).`,
      ].join('\n'),
    );
  });

  return { app, almacen };
}
