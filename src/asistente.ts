import type { Config } from './config.js';

// Cliente de la API del asistente del CMS (/api/v1/assistant/**, ver cms.grupoeytra.com/docs/asistente-api.md).
// El MCP nunca toca la base: llama a la API con su llave y dice quién pregunta (X-Eytra-User). La persona
// ya demostró quién es al iniciar sesión en el MCP (contraseña y, si la tiene, app de autenticación), así
// que aquí siempre va su id de Supabase, nunca un correo o teléfono que alguien escribió.
// La API decide el resto: RLS, herramientas apagadas, límites por persona y bitácora (assistant_log).

export type Resultado<T = unknown> = { ok: true; data: T } | { ok: false; status: number; error: string };

export interface Persona {
  user: { id: string; name: string | null; email: string | null; scope: 'client' | 'staff' | 'buyer'; role: string };
  company: { id: string; name: string } | null;
  /** Herramientas de la API que le tocan (ya descuenta las apagadas en la pantalla Asistente IA). */
  tools: string[];
}

const TIEMPO_MAXIMO_MS = 10_000;

export class ClienteAsistente {
  constructor(private readonly config: Pick<Config, 'asistenteUrl' | 'asistenteLlave'>) {}

  async llamar<T = unknown>(
    metodo: 'GET' | 'POST',
    ruta: string,
    opciones: { usuario?: string; cuerpo?: unknown; consulta?: Record<string, string | undefined> } = {},
  ): Promise<Resultado<T>> {
    const url = new URL(`${this.config.asistenteUrl}${ruta}`);
    for (const [clave, valor] of Object.entries(opciones.consulta ?? {})) {
      if (valor !== undefined && valor !== '') url.searchParams.set(clave, valor);
    }
    const encabezados: Record<string, string> = {
      Authorization: `Bearer ${this.config.asistenteLlave}`,
      // Sin canal propio en la API: «other» es el de las integraciones con sesión verificada.
      'X-Eytra-Channel': 'other',
    };
    if (opciones.usuario) encabezados['X-Eytra-User'] = opciones.usuario;
    let cuerpo: string | undefined;
    if (opciones.cuerpo !== undefined) {
      cuerpo = JSON.stringify(opciones.cuerpo);
      encabezados['Content-Type'] = 'application/json';
      encabezados['Content-Length'] = String(Buffer.byteLength(cuerpo));
    }

    let respuesta: Response;
    try {
      respuesta = await fetch(url, { method: metodo, headers: encabezados, body: cuerpo, signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS) });
    } catch (error) {
      console.error('[asistente] sin respuesta del CMS', { ruta, error: error instanceof Error ? error.message : String(error) });
      return { ok: false, status: 503, error: 'El sistema de Grupo Eytra no responde en este momento. Intente de nuevo en unos minutos.' };
    }

    type Cuerpo = { ok?: boolean; data?: T; error?: string };
    let json: Cuerpo | null = null;
    try {
      json = (await respuesta.json()) as Cuerpo;
    } catch {
      // Respuesta sin JSON (proxy caído, página de error): se trata abajo como error genérico.
    }
    if (respuesta.ok && json?.ok === true) return { ok: true, data: json.data as T };
    if (respuesta.status === 401) {
      // La llave del MCP fue revocada o es inválida: es un problema de configuración, no del usuario.
      console.error('[asistente] la API rechazó la llave del MCP', { ruta });
      return { ok: false, status: 503, error: 'El servicio no está disponible por un problema de configuración. Avise a Grupo Eytra.' };
    }
    return { ok: false, status: respuesta.status, error: json?.error || 'No se pudo completar la consulta.' };
  }

  /** Quién es la persona, su empresa y qué herramientas le tocan. 403/404 si no puede usar el asistente. */
  persona(usuarioId: string) {
    return this.llamar<Persona>('GET', '/me', { usuario: usuarioId });
  }
}
