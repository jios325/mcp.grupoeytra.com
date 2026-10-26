import { SignJWT, jwtVerify } from 'jose';

import { aleatorio } from './almacen.js';

// Access tokens del MCP: JWT HS256 firmados por este servidor, con la audiencia del recurso (RFC 8707).
// No son tokens de Supabase: el MCP solo los acepta para sí mismo y nunca los reenvía a otro servicio.

export const SCOPE = 'eytra';
export const DURACION_ACCESS_S = 60 * 60;
export const DURACION_REFRESH_MS = 30 * 24 * 60 * 60_000;

export interface Sujeto {
  usuarioId: string;
  clientId: string;
  scope: string;
  vence: number;
}

export class Tokens {
  private readonly llave: Uint8Array;

  constructor(
    secreto: string,
    private readonly emisor: string,
    private readonly audiencia: string,
  ) {
    this.llave = new TextEncoder().encode(secreto);
  }

  async firmar(usuarioId: string, clientId: string, scope: string): Promise<string> {
    return new SignJWT({ client_id: clientId, scope })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(this.emisor)
      .setAudience(this.audiencia)
      .setSubject(usuarioId)
      .setIssuedAt()
      .setExpirationTime(`${DURACION_ACCESS_S}s`)
      .setJti(aleatorio(12))
      .sign(this.llave);
  }

  /** null si el token no es nuestro, no es para este recurso o ya venció. */
  async verificar(token: string): Promise<Sujeto | null> {
    try {
      const { payload } = await jwtVerify(token, this.llave, {
        issuer: this.emisor,
        audience: this.audiencia,
        algorithms: ['HS256'],
        typ: 'at+jwt',
      });
      if (typeof payload.sub !== 'string' || typeof payload.client_id !== 'string' || typeof payload.exp !== 'number') return null;
      return { usuarioId: payload.sub, clientId: payload.client_id, scope: typeof payload.scope === 'string' ? payload.scope : '', vence: payload.exp };
    } catch {
      return null;
    }
  }
}
