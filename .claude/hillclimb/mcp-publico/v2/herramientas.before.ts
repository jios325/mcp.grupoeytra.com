import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { ClienteAsistente, Persona, Resultado } from './asistente.js';
import type { CmsPublico } from './publico/cms.js';
import { buscarEntradas, type Sitio } from './publico/sitio.js';
import type { Limitador } from './auth/limitador.js';

// Herramientas del MCP. Hay tres alcances, los mismos de la API del asistente:
//   - público: cualquiera, sin sesión (sitio, catálogo, blog, tienda, documentos públicos);
//   - cliente: usuarios de una empresa cliente (estado de cuenta, facturas, resultados, solicitudes);
//   - equipo: personal de Eytra sin doble factor obligatorio (resumen del día, documentos internos).
// Sin sesión se anuncian todas, para que la aplicación sepa que existen y pida iniciar sesión al
// llamarlas (lazy auth: servidor.ts responde 401 antes de llegar aquí). Con sesión solo se anuncian las
// que la API dice que le tocan a esa persona (`/me`), y la API vuelve a comprobarlo en cada llamada.

export const VERSION = '0.1.0';

/** Herramientas que requieren sesión, con la herramienta de la API que las respalda. */
export const PROTEGIDAS = {
  mi_cuenta: 'me',
  estado_de_cuenta: 'account_statement',
  archivos_de_factura: 'invoice_files',
  resultados_de_laboratorio: 'lab_results',
  crear_solicitud: 'create_request',
  resumen_del_dia: 'daily_summary',
} as const;

export type HerramientaProtegida = keyof typeof PROTEGIDAS;
export const esProtegida = (nombre: unknown): nombre is HerramientaProtegida => typeof nombre === 'string' && Object.hasOwn(PROTEGIDAS, nombre);

export interface Contexto {
  usuarioId: string | null;
  /** Resultado de /me para la persona con sesión (null sin sesión). */
  persona: Resultado<Persona> | null;
}

export interface Dependencias {
  sitio: Sitio;
  cms: CmsPublico;
  asistente: ClienteAsistente;
  /** Cupo global por hora de llamadas a la API sin persona (documentos). */
  cupoVisitantes: Limitador;
}

type Contenido = { content: { type: 'text'; text: string }[]; isError?: boolean };

const json = (datos: unknown): Contenido => ({ content: [{ type: 'text', text: JSON.stringify(datos, null, 2) }] });
const fallo = (mensaje: string): Contenido => ({ content: [{ type: 'text', text: mensaje }], isError: true });
const desdeApi = (r: Resultado): Contenido => (r.ok ? json(r.data) : fallo(r.error));

async function seguro(fn: () => Promise<Contenido>): Promise<Contenido> {
  try {
    return await fn();
  } catch (error) {
    console.error('[herramienta] error', error instanceof Error ? error.message : error);
    return fallo('No se pudo obtener la información en este momento. Intente de nuevo en unos minutos.');
  }
}

const LECTURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const INSTRUCCIONES = `Servidor de Grupo Eytra (tratamiento y análisis de agua en Cancún, Riviera Maya y Mérida).
- Información pública (sin iniciar sesión): para cualquier pregunta sobre servicios, normas, cobertura, cálculos o guías técnicas, empiece por buscar_en_sitio y lea la página con leer_pagina. El sitio tiene recursos propios, como una calculadora de dosificación de cloro: úselos y enlácelos en lugar de calcular por su cuenta. Para lo demás: datos_de_contacto, catalogo_de_productos (acepta orden por precio), envios_devoluciones_y_pagos, articulos_del_blog y documentos.
- Datos privados (requieren que la persona inicie sesión con la cuenta del portal de clientes o del CMS): mi_cuenta, estado_de_cuenta, archivos_de_factura, resultados_de_laboratorio, crear_solicitud y, para el equipo de Eytra, resumen_del_dia. Cada persona solo ve los datos de su empresa y lo que su rol permite. Si una de estas herramientas falla o la conexión se cierra, casi siempre es porque la persona no ha iniciado sesión: dígale que conecte su cuenta de Grupo Eytra (en Claude, con el botón «Conectar» del conector) y no lo presente como una falla del sistema. No vuelva a intentarlo en el mismo turno.
- Los precios del catálogo son de lista con IVA; descuentos solo con una cotización aprobada por Eytra. Para cotizar: https://grupoeytra.com/cotizacion.
- Responda en el idioma de la pregunta (español de México, de usted, si es en español). No invente cifras ni políticas: si un dato no está en las herramientas, dígalo. No complete con suposiciones lo que los datos no dicen (plazos de procesamiento, límites para facturar, de qué depende un precio, condiciones por zona); diga lo que sí está y ofrezca confirmarlo con Eytra.`;

export function crearServidor(dep: Dependencias, ctx: Contexto): McpServer {
  const servidor = new McpServer({ name: 'grupo-eytra', title: 'Grupo Eytra', version: VERSION }, { instructions: INSTRUCCIONES });
  registrarPublicas(servidor, dep, ctx);
  registrarPrivadas(servidor, dep, ctx);
  return servidor;
}

function registrarPublicas(servidor: McpServer, dep: Dependencias, ctx: Contexto) {
  const { sitio, cms, asistente } = dep;
  servidor.registerTool(
    'buscar_en_sitio',
    {
      title: 'Buscar en grupoeytra.com',
      description:
        'Busca páginas del sitio público de Grupo Eytra usando su índice llms.txt: servicios, sectores, cobertura por ciudad, laboratorio, normas NOM, productos, recursos (calculadora de dosificación de cloro, guías) y artículos del blog. Devuelve título, URL y descripción; después lea la página con leer_pagina. Sin consulta devuelve el índice completo y el resumen de la empresa.',
      inputSchema: z.object({ consulta: z.string().max(200).optional().describe('Palabras a buscar, por ejemplo "legionella hoteles" o "NOM-245"') }),
      annotations: LECTURA,
    },
    ({ consulta }) =>
      seguro(async () => {
        const { entradas, resumen } = await sitio.indiceSitio();
        if (!consulta?.trim()) return json({ resumen, paginas: entradas });
        const encontradas = buscarEntradas(entradas, consulta);
        return json({ consulta, paginas: encontradas, ...(encontradas.length === 0 ? { nota: 'Sin coincidencias; pruebe otras palabras o lea el índice completo sin consulta.' } : {}) });
      }),
  );

  servidor.registerTool(
    'leer_pagina',
    {
      title: 'Leer una página del sitio',
      description:
        'Devuelve el texto de una página de grupoeytra.com (ruta como "/laboratorio" o URL completa del mismo sitio). Si la página es larga, la respuesta trae continuar_desde para pedir el siguiente tramo.',
      inputSchema: z.object({
        ruta: z.string().min(1).max(500).describe('Ruta o URL de grupoeytra.com'),
        desde: z.number().int().min(0).max(2_000_000).optional().describe('Carácter desde el que continuar (valor de continuar_desde)'),
      }),
      annotations: LECTURA,
    },
    ({ ruta, desde }) =>
      seguro(async () => {
        const pagina = await sitio.leerPagina(ruta, desde ?? 0);
        if (!pagina.ok) return fallo(pagina.error);
        const { ok: _ok, ...resto } = pagina;
        return json(resto);
      }),
  );

  servidor.registerTool(
    'datos_de_contacto',
    {
      title: 'Datos de contacto y horario',
      description: 'Teléfono, WhatsApp, correo, dirección, horario y zona de entrega de Grupo Eytra, más el resumen de la empresa.',
      inputSchema: z.object({}),
      annotations: LECTURA,
    },
    () =>
      seguro(async () => {
        const [indice, ajustes] = await Promise.allSettled([sitio.indiceSitio(), cms.datosSitio()]);
        if (indice.status === 'rejected' && ajustes.status === 'rejected') throw indice.reason;
        return json({
          ...(ajustes.status === 'fulfilled' && ajustes.value ? { contacto: ajustes.value } : {}),
          ...(indice.status === 'fulfilled' ? { resumen: indice.value.resumen } : {}),
          cotizacion: 'https://grupoeytra.com/cotizacion',
        });
      }),
  );

  servidor.registerTool(
    'catalogo_de_productos',
    {
      title: 'Catálogo de productos',
      description:
        'Productos publicados en la tienda de Grupo Eytra con precio de lista en MXN (IVA incluido), modo de venta y presentación. Devuelve hasta 50 productos, el total que coincide y si hay más; para el más barato o el más caro use orden "precio_asc" o "precio_desc" en una sola llamada.',
      inputSchema: z.object({
        buscar: z.string().max(80).optional().describe('Nombre, categoría o palabra del resumen, por ejemplo "cloro" o "bomba"'),
        orden: z.enum(['destacados', 'precio_asc', 'precio_desc']).optional().describe('destacados (por omisión), precio_asc o precio_desc'),
        limite: z.number().int().min(1).max(50).optional().describe('Cuántos productos devolver (por omisión 20)'),
      }),
      annotations: LECTURA,
    },
    ({ buscar, orden, limite }) => seguro(async () => json(await cms.catalogo({ buscar, orden, limite }))),
  );

  servidor.registerTool(
    'envios_devoluciones_y_pagos',
    {
      title: 'Envíos, devoluciones y pagos de la tienda',
      description: 'Formas de entrega (cobertura, costo, envío gratis, tiempos, si llevan químicos), políticas de devolución, hora de corte, formas de pago y facturación de la tienda en línea.',
      inputSchema: z.object({}),
      annotations: LECTURA,
    },
    () => seguro(async () => json(await cms.tienda())),
  );

  servidor.registerTool(
    'articulos_del_blog',
    {
      title: 'Artículos del blog',
      description: 'Lista los artículos técnicos publicados en el blog (más recientes primero) y los temas disponibles. Para leer uno completo use leer_articulo con su slug.',
      inputSchema: z.object({
        buscar: z.string().max(80).optional().describe('Palabra en el título, extracto o resumen'),
        tema: z.string().max(80).optional().describe('Slug del tema'),
        limite: z.number().int().min(1).max(30).optional(),
      }),
      annotations: LECTURA,
    },
    ({ buscar, tema, limite }) =>
      seguro(async () => {
        const [articulos, temas] = await Promise.all([cms.articulos({ buscar, tema, limite }), cms.temasBlog()]);
        return json({ articulos, temas, url_blog: 'https://grupoeytra.com/blog' });
      }),
  );

  servidor.registerTool(
    'leer_articulo',
    {
      title: 'Leer un artículo del blog',
      description: 'Texto completo (Markdown) de un artículo publicado del blog, con autor, revisor, normas y productos relacionados.',
      inputSchema: z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160).describe('Slug del artículo (de articulos_del_blog)') }),
      annotations: LECTURA,
    },
    ({ slug }) =>
      seguro(async () => {
        const articulo = await cms.articulo(slug);
        return articulo ? json(articulo) : fallo('No hay un artículo publicado con ese slug.');
      }),
  );

  servidor.registerTool(
    'documentos',
    {
      title: 'Documentos de la base de conocimiento',
      description:
        'Lista los documentos de la base de conocimiento de Grupo Eytra (fichas, guías, políticas). Sin sesión solo los públicos; el equipo de Eytra con sesión también ve los internos. Use leer_documento para obtener el enlace.',
      inputSchema: z.object({}),
      annotations: LECTURA,
    },
    () => seguro(async () => conCupo(ctx, dep, () => asistente.llamar('GET', '/knowledge', { usuario: usuarioConAcceso(ctx) }))),
  );

  servidor.registerTool(
    'leer_documento',
    {
      title: 'Enlace a un documento',
      description: 'Devuelve un enlace de descarga a un documento de la base de conocimiento. El enlace caduca en 60 segundos: compártalo de inmediato.',
      inputSchema: z.object({ id: z.uuid().describe('id del documento (de la herramienta documentos)') }),
      annotations: LECTURA,
    },
    ({ id }) => seguro(async () => conCupo(ctx, dep, () => asistente.llamar('GET', `/knowledge/${id}`, { usuario: usuarioConAcceso(ctx) }))),
  );
}

/** El id solo se manda a la API cuando /me lo aceptó; si no, la consulta va como visitante. */
const usuarioConAcceso = (ctx: Contexto) => (ctx.usuarioId && ctx.persona?.ok ? ctx.usuarioId : undefined);

/**
 * La API limita la llave del MCP a 600 llamadas por hora para todos. Las de visitantes tienen un cupo
 * global propio para que un anónimo no deje sin servicio a quienes tienen sesión.
 */
async function conCupo(ctx: Contexto, dep: Dependencias, llamada: () => Promise<Resultado>): Promise<Contenido> {
  if (!usuarioConAcceso(ctx) && !dep.cupoVisitantes.tomar('visitantes')) {
    return fallo('Hay demasiadas consultas en este momento. Intente de nuevo más tarde o inicie sesión.');
  }
  return desdeApi(await llamada());
}

function registrarPrivadas(servidor: McpServer, { asistente }: Dependencias, ctx: Contexto) {
  const persona = ctx.persona;
  // Con sesión, cada herramienta aparece solo si la API se la da a esta persona.
  const disponible = (nombre: HerramientaProtegida) => {
    if (!ctx.usuarioId) return true;
    if (!persona?.ok) return nombre === 'mi_cuenta';
    return nombre === 'mi_cuenta' || persona.data.tools.includes(PROTEGIDAS[nombre]);
  };
  const comoPersona = (fn: (usuario: string) => Promise<Contenido>) =>
    seguro(async () => {
      if (!ctx.usuarioId) return fallo('Esta herramienta requiere iniciar sesión con su cuenta de Grupo Eytra.');
      if (!persona?.ok) return fallo(persona?.error ?? 'No se pudo verificar su cuenta.');
      return fn(ctx.usuarioId);
    });
  const sesion = ' Requiere iniciar sesión.';

  if (disponible('mi_cuenta')) {
    servidor.registerTool(
      'mi_cuenta',
      {
        title: 'Mi cuenta',
        description: `Quién es usted en Grupo Eytra: nombre, correo, rol, empresa y qué herramientas privadas puede usar.${sesion}`,
        inputSchema: z.object({}),
        annotations: LECTURA,
      },
      () => comoPersona(async () => json((persona as { data: Persona }).data)),
    );
  }

  if (disponible('estado_de_cuenta')) {
    servidor.registerTool(
      'estado_de_cuenta',
      {
        title: 'Estado de cuenta',
        description: `Saldo de la empresa: total por pagar, vencido, facturas abiertas (folio, fechas, total, saldo, estado) y último pago. Solo usuarios de empresas cliente.${sesion}`,
        inputSchema: z.object({}),
        annotations: LECTURA,
      },
      () => comoPersona(async (u) => desdeApi(await asistente.llamar('GET', '/account', { usuario: u }))),
    );
  }

  if (disponible('archivos_de_factura')) {
    servidor.registerTool(
      'archivos_de_factura',
      {
        title: 'PDF y XML de una factura',
        description: `Enlaces al PDF y al XML de una factura de su empresa, por folio (A-123) o UUID fiscal. Los enlaces caducan en 60 segundos: compártalos de inmediato.${sesion}`,
        inputSchema: z.object({ folio: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9-]+$/).describe('Folio (A-123) o UUID fiscal') }),
        annotations: LECTURA,
      },
      ({ folio }) => comoPersona(async (u) => desdeApi(await asistente.llamar('GET', `/invoices/${encodeURIComponent(folio)}/files`, { usuario: u }))),
    );
  }

  if (disponible('resultados_de_laboratorio')) {
    servidor.registerTool(
      'resultados_de_laboratorio',
      {
        title: 'Resultados de laboratorio',
        description: `Último resultado publicado de cada punto de muestreo de su empresa (o de una propiedad), con parámetros, valores, límites y si cumple. Solo resultados validados.${sesion}`,
        inputSchema: z.object({ propiedad: z.string().max(80).optional().describe('Nombre (o parte) de la propiedad') }),
        annotations: LECTURA,
      },
      ({ propiedad }) => comoPersona(async (u) => desdeApi(await asistente.llamar('GET', '/results', { usuario: u, consulta: { property: propiedad?.trim() } }))),
    );
  }

  if (disponible('crear_solicitud')) {
    servidor.registerTool(
      'crear_solicitud',
      {
        title: 'Crear solicitud de trabajo',
        description: `Crea una solicitud para el equipo de Eytra a nombre de su empresa (muestreo, químicos, mantenimiento, documentos, cambio de plan u otra). Confirme con el usuario el tipo, el título y la descripción antes de crearla.${sesion}`,
        inputSchema: z.object({
          tipo: z.enum(['sampling', 'chemicals', 'maintenance', 'documents', 'plan_change', 'other']).describe('sampling = muestreo, chemicals = químicos, maintenance = mantenimiento, documents = documentos, plan_change = cambio de plan, other = otra'),
          titulo: z.string().trim().min(3).max(140),
          descripcion: z.string().trim().min(3).max(4000),
          prioridad: z.enum(['high', 'normal', 'low']).optional(),
          fecha_preferida: z.iso.date().optional().describe('AAAA-MM-DD'),
          propiedad_id: z.uuid().optional(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      (a) =>
        comoPersona(async (u) =>
          desdeApi(
            await asistente.llamar('POST', '/requests', {
              usuario: u,
              cuerpo: {
                kind: a.tipo,
                title: a.titulo,
                description: a.descripcion,
                ...(a.prioridad ? { priority: a.prioridad } : {}),
                ...(a.fecha_preferida ? { preferred_date: a.fecha_preferida } : {}),
                ...(a.propiedad_id ? { property_id: a.propiedad_id } : {}),
              },
            }),
          ),
        ),
    );
  }

  if (disponible('resumen_del_dia')) {
    servidor.registerTool(
      'resumen_del_dia',
      {
        title: 'Resumen del día (equipo Eytra)',
        description: `Resumen diario para el equipo de Eytra: facturado, cobrado, por cobrar, igualas, muestras fuera de norma, inventario, solicitudes y pendientes de atención. Solo personal de Eytra.${sesion}`,
        inputSchema: z.object({}),
        annotations: LECTURA,
      },
      () => comoPersona(async (u) => desdeApi(await asistente.llamar('GET', '/summary', { usuario: u }))),
    );
  }
}
