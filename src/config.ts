// Configuración desde el entorno. Todo lo secreto vive en .env (local) o en el entorno del contenedor.

function requerida(nombre: string): string {
  const valor = process.env[nombre]?.trim();
  if (!valor) throw new Error(`Falta la variable de entorno ${nombre} (ver .env.example)`);
  return valor;
}

function opcional(nombre: string, porDefecto: string): string {
  return process.env[nombre]?.trim() || porDefecto;
}

const sinBarraFinal = (url: string) => url.replace(/\/+$/, '');

export interface Config {
  /** URL pública del servidor, sin barra final (https://mcp.grupoeytra.com). Es el issuer de OAuth. */
  urlPublica: string;
  /** Identificador del recurso protegido: la URL que el usuario pega en Claude (urlPublica + /mcp). */
  recurso: string;
  puerto: number;
  host: string;
  /** Nombres de host aceptados en el encabezado Host (protección contra DNS rebinding). */
  hostsPermitidos: string[];
  /** Sitio público del que salen llms.txt, el sitemap y las páginas. */
  sitio: string;
  supabaseUrl: string;
  supabaseLlavePublicable: string;
  /** API del asistente del CMS (/api/v1/assistant). */
  asistenteUrl: string;
  asistenteLlave: string;
  /** Secreto para firmar los access tokens (HS256) del MCP. Mínimo 32 caracteres. */
  secretoTokens: string;
  /** Archivo SQLite con clientes OAuth, códigos y refresh tokens. */
  rutaBase: string;
  /** Encabezado con la IP real que pone el proxy de confianza (Apache). Vacío: no se confía en ninguno. */
  encabezadoIp: string | null;
  /** Hosts https a los que puede volver el login (redirect_uri); el loopback http siempre se admite. */
  hostsRedirect: string[];
}

export function leerConfig(): Config {
  const urlPublica = sinBarraFinal(requerida('MCP_PUBLIC_URL'));
  const secretoTokens = requerida('MCP_TOKEN_SECRET');
  if (secretoTokens.length < 32) throw new Error('MCP_TOKEN_SECRET debe tener al menos 32 caracteres');
  const asistenteLlave = requerida('EYTRA_ASSISTANT_KEY');
  if (!/^eytra_ak_[0-9a-f]{64}$/.test(asistenteLlave)) throw new Error('EYTRA_ASSISTANT_KEY no tiene la forma eytra_ak_ + 64 hex');

  const hostPublico = new URL(urlPublica).hostname;
  const extra = opcional('MCP_ALLOWED_HOSTS', '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    urlPublica,
    recurso: `${urlPublica}/mcp`,
    puerto: Number(opcional('PORT', '8330')),
    host: opcional('HOST', '127.0.0.1'),
    hostsPermitidos: [...new Set([hostPublico, 'localhost', '127.0.0.1', ...extra])],
    sitio: sinBarraFinal(opcional('EYTRA_SITE_URL', 'https://grupoeytra.com')),
    supabaseUrl: sinBarraFinal(requerida('SUPABASE_URL')),
    supabaseLlavePublicable: requerida('SUPABASE_PUBLISHABLE_KEY'),
    asistenteUrl: sinBarraFinal(requerida('EYTRA_ASSISTANT_URL')),
    asistenteLlave,
    secretoTokens,
    rutaBase: opcional('MCP_DB_PATH', './data/mcp.sqlite'),
    encabezadoIp: process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || null,
    hostsRedirect: opcional('MCP_REDIRECT_HOSTS', 'claude.ai,claude.com,chatgpt.com')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
