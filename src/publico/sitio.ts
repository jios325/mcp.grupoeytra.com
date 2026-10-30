import { parse, type HTMLElement, type Node } from 'node-html-parser';

// Información pública del sitio grupoeytra.com: el índice de llms.txt (se genera en cada build del sitio
// con descripciones de cada sección), el sitemap y el texto de cualquier página del mismo dominio.
// Solo se piden URLs del sitio configurado: nada de URLs arbitrarias (evita usar el MCP como proxy).

export interface EntradaSitio {
  titulo: string;
  url: string;
  descripcion: string;
  seccion: string;
}

const TTL_INDICE_MS = 10 * 60_000;
const TIEMPO_MAXIMO_MS = 8_000;
const TAMANO_MAXIMO = 2 * 1024 * 1024;
export const LARGO_PAGINA = 12_000;

export const normalizar = (texto: string) =>
  texto
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Lee las líneas «- [Título](url): nota» de llms.txt con la sección (## …) a la que pertenecen. */
export function leerLlmsTxt(texto: string): EntradaSitio[] {
  const entradas: EntradaSitio[] = [];
  let seccion = 'General';
  for (const linea of texto.split('\n')) {
    const titulo = /^##\s+(.+)$/.exec(linea.trim());
    if (titulo) {
      seccion = titulo[1]!.trim();
      continue;
    }
    const enlace = /^-\s+\[([^\]]+)\]\(([^)\s]+)\)(?::\s*(.*))?$/.exec(linea.trim());
    if (enlace) entradas.push({ titulo: enlace[1]!, url: enlace[2]!, descripcion: (enlace[3] ?? '').trim(), seccion });
  }
  return entradas;
}

/** Puntúa cada entrada por las palabras de la consulta presentes en título, descripción y ruta. */
export function buscarEntradas<T extends EntradaSitio>(entradas: T[], consulta: string, limite = 10): T[] {
  const palabras = normalizar(consulta)
    .split(/[^a-z0-9ñ-]+/)
    .filter((p) => p.length > 2);
  if (palabras.length === 0) return entradas.slice(0, limite);
  // Raíz de 6 letras para palabras largas: «desinfectarla» encuentra «desinfectar».
  const raices = palabras.map((p) => (p.length > 6 ? p.slice(0, 6) : p));
  const puntuadas = entradas.map((e) => {
    const titulo = normalizar(e.titulo);
    const resto = normalizar(`${e.descripcion} ${e.seccion} ${e.url}`);
    let puntos = 0;
    for (const p of raices) {
      if (titulo.includes(p)) puntos += 3;
      if (resto.includes(p)) puntos += 1;
    }
    return { e, puntos };
  });
  return puntuadas
    .filter((x) => x.puntos > 0)
    .sort((a, b) => b.puntos - a.puntos)
    .slice(0, limite)
    .map((x) => x.e);
}

/**
 * Artículos del blog según llms.txt (rutas /blog/<slug>, sin las páginas en inglés ni el índice).
 * El sitio compila el blog desde Markdown en su repo; esto cubre lo que la vista del CMS aún no tiene.
 */
export function articulosDelIndice(entradas: EntradaSitio[]): (EntradaSitio & { slug: string })[] {
  return entradas.flatMap((e) => {
    const ruta = /^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(URL.canParse(e.url) ? new URL(e.url).pathname : '');
    return ruta ? [{ ...e, slug: ruta[1]! }] : [];
  });
}

export class Sitio {
  private indice: { entradas: EntradaSitio[]; resumen: string; vence: number } | null = null;
  private readonly origen: URL;
  private readonly host: string;

  constructor(private readonly base: string) {
    this.origen = new URL(base);
    this.host = this.origen.hostname.replace(/^www\./, '');
  }

  /** Convierte una ruta o URL del sitio en URL absoluta; null si es de otro dominio, esquema o puerto. */
  resolver(rutaOUrl: string): URL | null {
    let url: URL;
    try {
      url = new URL(rutaOUrl.trim(), `${this.base}/`);
    } catch {
      return null;
    }
    // Mismo esquema y puerto que el sitio: sin eso, grupoeytra.com:8081 llegaría a otros servicios del servidor.
    if (url.protocol !== this.origen.protocol || url.port !== this.origen.port) return null;
    if (url.username || url.password) return null;
    if (url.hostname.replace(/^www\./, '') !== this.host) return null;
    url.hash = '';
    return url;
  }

  private async pedir(url: URL, acepta: string): Promise<{ status: number; texto: string; url: URL }> {
    // Las redirecciones se siguen a mano para no salir del dominio.
    let actual = url;
    for (let salto = 0; salto < 5; salto++) {
      const respuesta = await fetch(actual, {
        redirect: 'manual',
        headers: { Accept: acepta, 'User-Agent': 'mcp.grupoeytra.com' },
        signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
      });
      if (respuesta.status >= 300 && respuesta.status < 400) {
        const destino = this.resolver(new URL(respuesta.headers.get('location') ?? '', actual).toString());
        if (!destino) return { status: 404, texto: '', url: actual };
        actual = destino;
        continue;
      }
      const largo = Number(respuesta.headers.get('content-length') ?? 0);
      if (largo > TAMANO_MAXIMO) return { status: 413, texto: '', url: actual };
      const texto = await respuesta.text();
      return { status: respuesta.status, texto: texto.slice(0, TAMANO_MAXIMO), url: actual };
    }
    return { status: 508, texto: '', url: actual };
  }

  /** Índice de llms.txt (con caché de 10 minutos) y su encabezado (qué es la empresa y contacto). */
  async indiceSitio(): Promise<{ entradas: EntradaSitio[]; resumen: string }> {
    if (this.indice && this.indice.vence > Date.now()) return this.indice;
    const { status, texto } = await this.pedir(new URL('/llms.txt', this.base), 'text/plain');
    if (status !== 200) throw new Error(`llms.txt respondió ${status}`);
    const corte = texto.search(/^##\s/m);
    const resumen = (corte > 0 ? texto.slice(0, corte) : texto.slice(0, 3000)).trim();
    this.indice = { entradas: leerLlmsTxt(texto), resumen, vence: Date.now() + TTL_INDICE_MS };
    return this.indice;
  }

  /** Texto legible de una página del sitio, por tramos de LARGO_PAGINA caracteres. */
  async leerPagina(rutaOUrl: string, desde = 0) {
    const url = this.resolver(rutaOUrl);
    if (!url) return { ok: false as const, error: `Solo se pueden leer páginas de ${this.base}.` };
    const { status, texto, url: final } = await this.pedir(url, 'text/html');
    if (status === 404) return { ok: false as const, error: `La página ${final.pathname} no existe en el sitio.` };
    if (status !== 200) return { ok: false as const, error: `El sitio respondió ${status} para ${final.pathname}.` };
    const pagina = extraerTexto(texto);
    const tramo = pagina.texto.slice(desde, desde + LARGO_PAGINA);
    const siguiente = desde + LARGO_PAGINA < pagina.texto.length ? desde + LARGO_PAGINA : null;
    return {
      ok: true as const,
      url: final.toString(),
      titulo: pagina.titulo,
      descripcion: pagina.descripcion,
      texto: tramo,
      largo_total: pagina.texto.length,
      ...(siguiente !== null ? { continuar_desde: siguiente } : {}),
    };
  }
}

const OMITIR = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'header', 'nav', 'footer', 'form', 'button', 'dialog']);
const BLOQUES = new Set(['p', 'div', 'section', 'article', 'main', 'aside', 'ul', 'ol', 'table', 'tr', 'blockquote', 'figure', 'figcaption', 'dl', 'details', 'summary']);

/** Título, descripción y texto principal (<main> si existe) de un HTML, en Markdown sencillo. */
export function extraerTexto(html: string): { titulo: string; descripcion: string; texto: string } {
  const raiz = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const titulo = raiz.querySelector('title')?.text.trim() ?? '';
  const descripcion = raiz.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '';
  const principal = raiz.querySelector('main') ?? raiz.querySelector('body') ?? raiz;
  const partes: string[] = [];
  recorrer(principal, partes);
  const texto = partes
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { titulo, descripcion, texto };
}

function recorrer(nodo: Node, partes: string[]) {
  for (const hijo of nodo.childNodes) {
    if (hijo.nodeType === 3) {
      partes.push(decodificar(hijo.rawText).replace(/\s+/g, ' '));
      continue;
    }
    if (hijo.nodeType !== 1) continue;
    const el = hijo as HTMLElement;
    const etiqueta = el.tagName?.toLowerCase() ?? '';
    if (OMITIR.has(etiqueta) || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) continue;
    const nivel = /^h([1-6])$/.exec(etiqueta);
    if (nivel) {
      partes.push(`\n\n${'#'.repeat(Number(nivel[1]))} ${el.text.replace(/\s+/g, ' ').trim()}\n\n`);
      continue;
    }
    if (etiqueta === 'li') partes.push('\n- ');
    else if (etiqueta === 'br') partes.push('\n');
    else if (etiqueta === 'td' || etiqueta === 'th') partes.push(' | ');
    else if (BLOQUES.has(etiqueta)) partes.push('\n\n');
    recorrer(el, partes);
    if (BLOQUES.has(etiqueta)) partes.push('\n\n');
  }
}

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodificar(texto: string): string {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entera, codigo: string) => {
    if (codigo[0] === '#') {
      const numero = codigo[1] === 'x' || codigo[1] === 'X' ? parseInt(codigo.slice(2), 16) : parseInt(codigo.slice(1), 10);
      return Number.isFinite(numero) ? String.fromCodePoint(numero) : entera;
    }
    return ENTIDADES[codigo.toLowerCase()] ?? entera;
  });
}
