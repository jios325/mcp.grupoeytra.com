import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';

// Vista de Grupo Eytra (MCP App). Corre en un iframe aislado dentro del cliente (Claude, ChatGPT, VS Code):
// recibe por postMessage el resultado de la herramienta que la abrió y lo dibuja. No habla con el servidor
// ni con el CMS: cuando necesita más datos (el PDF de una factura, otra búsqueda del catálogo) le pide al
// cliente que llame otra herramienta del mismo MCP, con la misma sesión, los mismos permisos y los mismos topes.
// Todo lo que llega se escribe como texto (nunca innerHTML): son datos del CMS y del sitio, no HTML de confianza.

type D = Record<string, any>;
type Hijo = Node | string | number | null | undefined | false | Hijo[];
type Tono = 'bien' | 'alerta' | 'mal' | '';
type Lectura = { ok: true; datos: D } | { ok: false; error: string };

const app = new App({ name: 'Grupo Eytra', version: '0.1.0' });
const raiz = document.getElementById('raiz') as HTMLElement;

// ───────────────────────── DOM ─────────────────────────

function agregar(el: HTMLElement, hijos: Hijo[]) {
  for (const hijo of hijos) {
    if (Array.isArray(hijo)) agregar(el, hijo);
    else if (hijo instanceof Node) el.append(hijo);
    else if (hijo !== null && hijo !== undefined && hijo !== false) el.append(String(hijo));
  }
}

/** h('div.tarjeta', { role: 'status' }, hijos…): elemento con clases y atributos; el texto nunca se interpreta como HTML. */
function h(etiqueta: string, atributos: Record<string, string | undefined> | null = null, ...hijos: Hijo[]): HTMLElement {
  const [nombre, ...clases] = etiqueta.split('.');
  const el = document.createElement(nombre || 'div');
  if (clases.length > 0) el.className = clases.join(' ');
  for (const [clave, valor] of Object.entries(atributos ?? {})) if (valor !== undefined) el.setAttribute(clave, valor);
  agregar(el, hijos);
  return el;
}

/** Sustituye el contenido de un elemento. */
function reemplazar(el: HTMLElement, ...hijos: Hijo[]) {
  el.replaceChildren();
  agregar(el, hijos);
}

const tarjeta = (...hijos: Hijo[]) => h('section.tarjeta', null, ...hijos);
const insignia = (texto: string, tono: Tono = '') => h(`span.insignia${tono ? `.${tono}` : ''}`, null, texto);
const aviso = (texto: string, tono: Tono = '') => h(`p.aviso${tono ? `.${tono}` : ''}`, { role: tono === 'mal' ? 'alert' : 'status' }, texto);
const cifra = (titulo: string, valor: string, tono: Tono = '', pie?: string) => h(`div.cifra${tono ? `.${tono}` : ''}`, null, h('span.chico.tenue', null, titulo), h('b', null, valor), pie ? h('span.chico.tenue', null, pie) : null);

function boton(texto: string, accion: () => unknown, clase = ''): HTMLButtonElement {
  const b = h(`button${clase ? `.${clase}` : ''}`, { type: 'button' }, texto) as HTMLButtonElement;
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.nextElementSibling?.matches('[data-error]') && b.nextElementSibling.remove();
    try {
      await accion();
    } catch (error) {
      b.after(h('span.chico.tenue', { 'data-error': '', role: 'alert' }, ` ${error instanceof Error ? error.message : 'No se pudo completar.'}`));
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

interface Columna {
  titulo: string;
  celda: (fila: D) => Hijo;
  num?: boolean;
}

function tabla(columnas: Columna[], filas: D[]) {
  return h(
    'div.desborde',
    null,
    h(
      'table',
      null,
      h('thead', null, h('tr', null, columnas.map((c) => h(c.num ? 'th.num' : 'th', { scope: 'col' }, c.titulo)))),
      h('tbody', null, filas.map((fila) => h('tr', null, columnas.map((c) => h(c.num ? 'td.num' : 'td', null, c.celda(fila)))))),
    ),
  );
}

// ───────────────────────── Formato ─────────────────────────

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const numero = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const dinero = (v: unknown) => {
  const n = numero(v);
  return n === null ? '—' : MXN.format(n);
};
const texto = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const lista = (v: unknown): D[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

const ES_FECHA = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2})?/;
/** Fechas sin hora tal como vienen (sin pasar por la zona del navegador); con hora, en la hora local. */
function fecha(v: unknown): string {
  if (typeof v !== 'string') return '—';
  const m = ES_FECHA.exec(v);
  if (!m) return v;
  if (v.length === 10) return `${Number(m[3])} ${MESES[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Solo el día de una fecha con hora (publicación de un artículo, actualización de un documento). */
function dia(v: unknown): string {
  if (typeof v !== 'string' || v.length === 10) return fecha(v);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
}

const ETIQUETAS: Record<string, string> = {
  // resumen del día
  billed: 'Facturado', collected: 'Cobrado', receivable: 'Por cobrar', subscriptions: 'Igualas', lab: 'Laboratorio', inventory: 'Inventario',
  requests: 'Solicitudes', attention: 'Pendientes de atención', chart: 'Últimos meses', month: 'Mes', today: 'Hoy', overdue: 'Vencido',
  overdue_count: 'Facturas vencidas', out_of_norm: 'Fuera de norma', unassigned: 'Sin asignar', low: 'Bajo mínimo', low_stock: 'Bajo mínimo',
  total: 'Total', count: 'Cantidad', amount: 'Monto', balance: 'Saldo', company: 'Empresa', folio: 'Folio', due_date: 'Vence', parameters: 'Parámetros',
  updated_at: 'Actualizado', active: 'Activas', pending: 'Pendientes', samples: 'Muestras', name: 'Nombre', status: 'Estado', date: 'Fecha',
  current: 'Periodo actual', previous: 'Periodo anterior', monthly: 'Mensual', monthly_amount: 'Mensual', min_stock: 'Mínimo', quantity: 'Existencia', unit: 'Unidad',
  kind: 'Tipo', created_at: 'Creada', ends_on: 'Termina', property: 'Propiedad', technician: 'Técnico', day: 'Día', points: 'Puntos', water_types: 'Tipos de agua',
  // tienda
  cutoff_time: 'Hora de corte', business_days: 'Días hábiles', pickup_address: 'Recolección en', local_delivery_mode: 'Entrega local',
  payment_methods: 'Formas de pago', invoice_mode: 'Facturación', invoice_window: 'Plazo para facturar', volume_purchases: 'Compras por volumen',
  coverage: 'Cobertura', cost: 'Costo', free_from: 'Envío gratis desde', lead_time: 'Tiempo de entrega', accepts_chemicals: 'Lleva químicos',
  window_label: 'Plazo', return_shipping: 'Envío de la devolución',
  // contacto
  phone: 'Teléfono', whatsapp: 'WhatsApp', forms_email: 'Correo', hours: 'Horario', delivery_zone: 'Zona de entrega',
};
const DINERO = new Set(['billed', 'collected', 'receivable', 'overdue', 'total', 'amount', 'balance', 'cost', 'free_from', 'total_due', 'subtotal', 'tax', 'price', 'current', 'previous', 'monthly', 'monthly_amount']);
const OCULTAS = new Set(['id', 'ratio']);
const etiqueta = (clave: string) => ETIQUETAS[clave] ?? clave.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

/** Dibuja cualquier valor JSON: sirve para lo que la API puede cambiar (resumen del día, ajustes de la tienda). */
function generico(valor: unknown, clave = ''): Hijo {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (typeof valor === 'boolean') return valor ? 'Sí' : 'No';
  if (typeof valor === 'number') return DINERO.has(clave) ? dinero(valor) : valor.toLocaleString('es-MX');
  if (typeof valor === 'string') return ES_FECHA.test(valor) ? fecha(valor) : valor;
  if (Array.isArray(valor)) {
    if (valor.length === 0) return 'Ninguno';
    const filas = lista(valor);
    if (filas.length !== valor.length) return valor.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
    const claves = [...new Set(filas.flatMap((f) => Object.keys(f)))].filter((k) => !OCULTAS.has(k)).slice(0, 6);
    return tabla(claves.map((k) => ({ titulo: etiqueta(k), celda: (f: D) => generico(f[k], k), num: DINERO.has(k) })), filas);
  }
  const entradas = Object.entries(valor as D).filter(([k]) => !OCULTAS.has(k));
  if (entradas.length === 0) return '—';
  return h('dl', null, entradas.map(([k, v]) => [h('dt', null, etiqueta(k)), h('dd', null, generico(v, k))]));
}

// ───────────────────────── Cliente ─────────────────────────

/** Saca los datos del resultado de una herramienta: el JSON del primer bloque de texto (así responden todas). */
function leer(resultado: { content?: unknown; isError?: boolean; structuredContent?: unknown } | null | undefined): Lectura {
  const bloques = Array.isArray(resultado?.content) ? (resultado.content as { type?: string; text?: string }[]) : [];
  const primero = bloques.find((b) => b?.type === 'text' && typeof b.text === 'string')?.text ?? '';
  if (resultado?.isError) return { ok: false, error: primero || 'No se pudo obtener la información.' };
  if (resultado?.structuredContent && typeof resultado.structuredContent === 'object') return { ok: true, datos: resultado.structuredContent as D };
  try {
    const datos: unknown = JSON.parse(primero);
    if (datos && typeof datos === 'object' && !Array.isArray(datos)) return { ok: true, datos: datos as D };
    return { ok: true, datos: { valor: datos } };
  } catch {
    return { ok: true, datos: { texto: primero } };
  }
}

async function llamar(nombre: string, argumentos: D = {}): Promise<D> {
  const lectura = leer(await app.callServerTool({ name: nombre, arguments: argumentos }));
  if (!lectura.ok) throw new Error(lectura.error);
  return lectura.datos;
}

/** Abre un enlace en el navegador de la persona (lo decide el cliente). Solo https, o localhost en desarrollo. */
async function abrir(url: unknown) {
  if (typeof url !== 'string' || !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/i.test(url)) throw new Error('El enlace no está disponible.');
  const respuesta = await app.openLink({ url });
  if (respuesta?.isError) throw new Error('El cliente no permitió abrir el enlace.');
}

const enlace = (rotulo: string, url: unknown) => boton(rotulo, () => abrir(url), 'enlace');

// ───────────────────────── Vistas públicas ─────────────────────────

function vistaBusqueda(d: D): Hijo {
  const paginas = lista(d.paginas);
  return tarjeta(
    h('div.encabezado', null, h('h1', null, d.consulta ? `Resultados para «${d.consulta}»` : 'Índice de grupoeytra.com'), h('span.chico.tenue', null, `${paginas.length} ${paginas.length === 1 ? 'página' : 'páginas'}`)),
    d.resumen ? h('p.tenue', null, d.resumen) : null,
    d.nota ? aviso(d.nota) : null,
    h('div.lista', null, paginas.map((p) => h('div.pila', null, h('div.fila', null, enlace(texto(p.titulo), p.url), p.seccion ? insignia(p.seccion) : null), p.descripcion ? h('p.chico.tenue', null, p.descripcion) : null))),
  );
}

function vistaPagina(d: D): Hijo {
  const cuerpo = h('p.texto', null, texto(d.texto));
  const pie = h('div.fila');
  const pintarPie = (siguiente: unknown) => {
    pie.replaceChildren();
    if (typeof siguiente === 'number') {
      pie.append(
        boton('Seguir leyendo', async () => {
          const mas = await llamar('leer_pagina', { ruta: d.url, desde: siguiente });
          cuerpo.append(String(mas.texto ?? ''));
          pintarPie(mas.continuar_desde);
        }),
      );
    }
    if (d.url) pie.append(boton('Abrir en el sitio', () => abrir(d.url), 'principal'));
  };
  pintarPie(d.continuar_desde);
  return tarjeta(h('h1', null, texto(d.titulo ?? d.title)), d.descripcion ? h('p.tenue', null, d.descripcion) : null, cuerpo, pie);
}

function vistaContacto(d: D): Hijo {
  const c: D = d.contacto ?? {};
  const digitos = String(c.whatsapp ?? '').replace(/\D/g, '');
  const whatsapp = digitos.length === 10 ? `52${digitos}` : digitos;
  const filas: [string, unknown][] = [['Teléfono', c.phone], ['WhatsApp', c.whatsapp], ['Correo', c.forms_email], ['Horario', c.hours], ['Zona de entrega', c.delivery_zone]];
  const visibles = filas.filter(([, v]) => v);
  return tarjeta(
    h('h1', null, 'Grupo Eytra · contacto'),
    visibles.length > 0 ? h('dl', null, visibles.map(([k, v]) => [h('dt', null, k), h('dd', null, generico(v))])) : null,
    d.resumen ? h('p.tenue', null, d.resumen) : null,
    h('div.fila', null, d.cotizacion ? boton('Pedir cotización', () => abrir(d.cotizacion), 'principal') : null, whatsapp.length >= 12 ? boton('Escribir por WhatsApp', () => abrir(`https://wa.me/${whatsapp}`)) : null),
  );
}

function vistaCatalogo(d: D, argumentos: D = {}): Hijo {
  const cuerpo = h('div.pila');
  const pintar = (datos: D) => {
    const productos = lista(datos.productos);
    reemplazar(
      cuerpo,
      h('p.chico.tenue', { role: 'status' }, productos.length === 0 ? 'Sin productos con esa búsqueda.' : `Mostrando ${productos.length} de ${texto(datos.total ?? productos.length)}${datos.hay_mas ? ' (hay más: afine la búsqueda)' : ''}.`),
      h(
        'div.rejilla',
        null,
        productos.map((p) => {
          const presentacion = [p.pack_quantity, p.pack_unit].filter((x) => x !== null && x !== undefined && x !== '').join(' ');
          return h(
            'article.producto',
            null,
            h('h3', null, texto(p.name)),
            h('div.fila', null, p.category ? insignia(String(p.category)) : null, presentacion ? h('span.chico.tenue', null, presentacion) : null),
            p.summary ? h('p.chico.tenue', null, p.summary) : null,
            h('div.precio', null, dinero(p.price), p.recurring_interval ? h('span.chico.tenue', null, ` / ${p.recurring_interval}`) : null),
            datos.tienda && p.slug ? enlace('Ver en la tienda', `${datos.tienda}/${p.slug}`) : null,
          );
        }),
      ),
      datos.nota ? h('p.chico.tenue', null, datos.nota) : null,
    );
  };
  const buscar = h('input', { type: 'search', name: 'buscar', placeholder: 'Buscar: cloro, bomba…', 'aria-label': 'Buscar en el catálogo', maxlength: '80', value: typeof argumentos.buscar === 'string' ? argumentos.buscar : undefined }) as HTMLInputElement;
  const orden = h('select', { name: 'orden', 'aria-label': 'Orden' }, h('option', { value: 'destacados' }, 'Destacados'), h('option', { value: 'precio_asc' }, 'Precio: menor a mayor'), h('option', { value: 'precio_desc' }, 'Precio: mayor a menor')) as HTMLSelectElement;
  orden.value = typeof d.orden === 'string' ? d.orden : 'destacados';
  const enviar = boton('Buscar', async () => pintar(await llamar('catalogo_de_productos', { ...(buscar.value.trim() ? { buscar: buscar.value.trim() } : {}), orden: orden.value, limite: 24 })), 'principal');
  const formulario = h('form.fila', { role: 'search' }, buscar, orden, enviar);
  formulario.addEventListener('submit', (evento) => {
    evento.preventDefault();
    enviar.click();
  });
  orden.addEventListener('change', () => enviar.click());
  pintar(d);
  return tarjeta(h('h1', null, 'Catálogo de productos'), formulario, cuerpo);
}

function vistaTienda(d: D): Hijo {
  const entregas = lista(d.entregas);
  const devoluciones = lista(d.devoluciones);
  return [
    tarjeta(
      h('h1', null, 'Envíos y entregas'),
      entregas.length === 0
        ? h('p.tenue', null, 'Sin formas de entrega publicadas.')
        : tabla(
            [
              { titulo: 'Forma de entrega', celda: (e) => h('b', null, texto(e.name)) },
              { titulo: 'Cobertura', celda: (e) => texto(e.coverage) },
              { titulo: 'Costo', celda: (e) => (numero(e.cost) === null ? texto(e.cost) : numero(e.cost) === 0 ? 'Gratis' : dinero(e.cost)), num: true },
              { titulo: 'Gratis desde', celda: (e) => (numero(e.free_from) === null ? '—' : dinero(e.free_from)), num: true },
              { titulo: 'Tiempo', celda: (e) => texto(e.lead_time) },
              { titulo: 'Químicos', celda: (e) => (e.accepts_chemicals === true ? insignia('Sí', 'bien') : e.accepts_chemicals === false ? insignia('No') : '—') },
            ],
            entregas,
          ),
    ),
    devoluciones.length > 0
      ? tarjeta(h('h2', null, 'Devoluciones'), h('div.lista', null, devoluciones.map((x) => h('div.pila', null, h('div.fila', null, h('b', null, texto(x.name)), x.window_label ? insignia(String(x.window_label)) : null), x.body ? h('p.chico', null, x.body) : null, x.return_shipping ? h('p.chico.tenue', null, `Envío de la devolución: ${x.return_shipping}`) : null))))
      : null,
    d.ajustes ? tarjeta(h('h2', null, 'Pagos y facturación'), generico(d.ajustes)) : null,
  ];
}

function vistaBlog(d: D): Hijo {
  const contenedor = h('div.pila');
  const pintarLista = (datos: D) => {
    const articulos = lista(datos.articulos);
    const temas = lista(datos.temas);
    reemplazar(
      contenedor,
      tarjeta(
        h('h1', null, 'Blog de Grupo Eytra'),
        temas.length > 0 ? h('div.fila', null, temas.map((t) => boton(texto(t.name), async () => pintarLista({ ...(await llamar('articulos_del_blog', { tema: t.slug })), temas })))) : null,
        datos.nota ? aviso(datos.nota) : null,
        h(
          'div.lista',
          null,
          articulos.map((a) =>
            h(
              'div.pila',
              null,
              h('h3', null, texto(a.title)),
              h('p.chico.tenue', null, [a.topic_name, a.author_name, a.publish_at ? dia(String(a.publish_at)) : null].filter(Boolean).join(' · ')),
              a.excerpt ? h('p.chico', null, a.excerpt) : null,
              h(
                'div.fila',
                null,
                boton('Leer aquí', async () => {
                  const articulo = await llamar('leer_articulo', { slug: a.slug });
                  reemplazar(contenedor, h('div.fila', null, boton('← Volver a la lista', () => pintarLista(datos))), vistaArticulo({ ...articulo, url: articulo.url ?? a.url ?? (datos.url_blog ? `${datos.url_blog}/${a.slug}` : undefined) }));
                }),
                enlace('Abrir en el blog', a.url ?? (datos.url_blog ? `${datos.url_blog}/${a.slug}` : undefined)),
              ),
            ),
          ),
        ),
      ),
    );
  };
  pintarLista(d);
  return contenedor;
}

/** Markdown mínimo y seguro: títulos, listas, párrafos, negritas y enlaces https. Lo demás queda como texto. */
function markdown(fuente: string): HTMLElement {
  const enLinea = (linea: string): Hijo[] =>
    linea.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g).map((parte) => {
      const negrita = /^\*\*([^*]+)\*\*$/.exec(parte);
      if (negrita) return h('strong', null, negrita[1]);
      const vinculo = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(parte);
      if (vinculo) return /^https:\/\//i.test(vinculo[2] ?? '') ? enlace(vinculo[1] ?? '', vinculo[2]) : vinculo[1];
      return parte;
    });
  const salida = h('div.articulo');
  let listaActual: HTMLElement | null = null;
  let parrafo: string[] = [];
  const cerrar = () => {
    if (parrafo.length > 0) salida.append(h('p', null, enLinea(parrafo.join(' '))));
    parrafo = [];
  };
  for (const linea of fuente.split(/\r?\n/)) {
    const titulo = /^(#{1,6})\s+(.*)$/.exec(linea);
    const punto = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(linea);
    if (titulo) {
      cerrar();
      listaActual = null;
      salida.append(h((titulo[1] ?? '').length <= 2 ? 'h2' : 'h3', null, enLinea(titulo[2] ?? '')));
    } else if (punto) {
      cerrar();
      const tipo = punto[1] ? 'ol' : 'ul';
      if (!listaActual || listaActual.tagName.toLowerCase() !== tipo) {
        listaActual = h(tipo);
        salida.append(listaActual);
      }
      listaActual.append(h('li', null, enLinea(punto[2] ?? '')));
    } else if (linea.trim() === '') {
      cerrar();
      listaActual = null;
    } else {
      listaActual = null;
      parrafo.push(linea.trim());
    }
  }
  cerrar();
  return salida;
}

function vistaArticulo(d: D): Hijo {
  if (typeof d.body_md !== 'string') return vistaPagina(d);
  const firma = [d.author_name ? `Por ${d.author_name}${d.author_role ? `, ${d.author_role}` : ''}` : null, d.reviewer_name ? `Revisó ${d.reviewer_name}` : null, d.publish_at ? dia(String(d.publish_at)) : null].filter(Boolean).join(' · ');
  const normas: unknown[] = Array.isArray(d.related_norms) ? d.related_norms : [];
  return tarjeta(
    h('div.fila', null, d.topic_name ? insignia(String(d.topic_name)) : null, normas.map((n) => insignia(String(n)))),
    h('h1', null, texto(d.title)),
    firma ? h('p.chico.tenue', null, firma) : null,
    markdown(d.body_md),
    d.url ? h('div.fila', null, boton('Abrir en el blog', () => abrir(d.url), 'principal')) : null,
  );
}

const VISIBILIDAD: Record<string, [string, Tono]> = { public: ['Público', 'bien'], internal: ['Interno', 'alerta'] };

function vistaDocumentos(d: D): Hijo {
  const documentos = lista(d.documents);
  return tarjeta(
    h('h1', null, 'Documentos'),
    documentos.length === 0
      ? h('p.tenue', null, 'No hay documentos disponibles.')
      : h(
          'div.lista',
          null,
          documentos.map((doc) => {
            const [rotulo, tono] = VISIBILIDAD[String(doc.visibility)] ?? [texto(doc.visibility), ''];
            return h(
              'div.encabezado',
              null,
              h('div.pila', null, h('b', null, texto(doc.title)), h('span.chico.tenue', null, doc.updated_at ? `Actualizado ${dia(String(doc.updated_at))}` : '')),
              h(
                'div.fila',
                null,
                doc.visibility ? insignia(rotulo, tono) : null,
                boton('Abrir', async () => {
                  const archivo = await llamar('leer_documento', { id: doc.id });
                  if (!archivo.url) throw new Error('Este documento no tiene archivo.');
                  await abrir(archivo.url);
                }),
              ),
            );
          }),
        ),
  );
}

function vistaDocumento(d: D): Hijo {
  return tarjeta(h('h1', null, texto(d.title)), d.url ? h('div.fila', null, boton('Abrir documento', () => abrir(d.url), 'principal'), h('span.chico.tenue', null, 'El enlace caduca en 60 segundos.')) : aviso('Este documento no tiene archivo.', 'alerta'));
}

// ───────────────────────── Vistas con sesión ─────────────────────────

const HERRAMIENTAS: Record<string, string> = {
  me: 'Mi cuenta', account_statement: 'Estado de cuenta', invoice_files: 'PDF y XML de facturas', lab_results: 'Resultados de laboratorio', create_request: 'Crear solicitudes',
  daily_summary: 'Resumen del día', create_quote: 'Crear cotizaciones', quote_status: 'Estado de cotizaciones', catalog_quote: 'Catálogo', catalog: 'Catálogo', knowledge: 'Documentos',
};
const ALCANCE: Record<string, string> = { client: 'Cliente', staff: 'Equipo Eytra', buyer: 'Comprador' };

function vistaCuenta(d: D): Hijo {
  const u: D = d.user ?? {};
  const herramientas: unknown[] = Array.isArray(d.tools) ? d.tools : [];
  return tarjeta(
    h('div.encabezado', null, h('h1', null, texto(u.name ?? u.email)), u.scope ? insignia(ALCANCE[String(u.scope)] ?? String(u.scope), 'bien') : null),
    h('dl', null, h('dt', null, 'Correo'), h('dd', null, texto(u.email)), h('dt', null, 'Rol'), h('dd', null, texto(u.role)), d.company ? [h('dt', null, 'Empresa'), h('dd', null, texto(d.company.name))] : null),
    herramientas.length > 0 ? h('div.pila', null, h('h2', null, 'Lo que puede consultar'), h('div.fila', null, herramientas.map((t) => insignia(HERRAMIENTAS[String(t)] ?? String(t))))) : null,
  );
}

function archivosDeFactura(a: D): Hijo {
  if (!a.pdf_url && !a.xml_url) return h('span.chico.tenue', null, 'Sin archivos');
  return h('div.fila', null, a.pdf_url ? boton('PDF', () => abrir(a.pdf_url), 'principal') : null, a.xml_url ? boton('XML', () => abrir(a.xml_url)) : null);
}

function vistaEstadoDeCuenta(d: D): Hijo {
  const facturas = lista(d.invoices);
  const vencido = numero(d.overdue) ?? 0;
  const pago: D | null = d.last_payment ?? null;
  return tarjeta(
    h('div.encabezado', null, h('h1', null, `Estado de cuenta${d.company ? ` · ${typeof d.company === 'object' ? texto(d.company.name) : d.company}` : ''}`), d.today ? h('span.chico.tenue', null, `Al ${fecha(String(d.today))}`) : null),
    h(
      'div.cifras',
      null,
      cifra('Total por pagar', dinero(d.total_due)),
      cifra('Vencido', dinero(d.overdue), vencido > 0 ? 'mal' : '', d.overdue_count ? `${d.overdue_count} ${Number(d.overdue_count) === 1 ? 'factura' : 'facturas'}` : undefined),
      cifra('Último pago', pago ? dinero(pago.amount) : '—', '', pago?.paid_on ? fecha(String(pago.paid_on)) : undefined),
    ),
    facturas.length === 0
      ? aviso('No hay facturas abiertas.', 'bien')
      : tabla(
          [
            { titulo: 'Folio', celda: (f) => h('div.pila.junto', null, h('b', null, texto(f.folio)), f.period ? h('span.chico.tenue', null, String(f.period)) : null) },
            { titulo: 'Vence', celda: (f) => h('div.pila.junto', null, h('span', null, fecha(f.due_date)), f.issued_on ? h('span.chico.tenue', null, `Emitida ${fecha(f.issued_on)}`) : null) },
            { titulo: 'Saldo', celda: (f) => h('div.pila.junto', null, h('b', null, dinero(f.balance)), h('span.chico.tenue', null, `de ${dinero(f.total)}`)), num: true },
            { titulo: 'Estado', celda: (f) => (f.status === 'vencida' ? insignia('Vencida', 'mal') : f.status === 'por_vencer' ? insignia('Por vencer', 'alerta') : insignia(texto(f.status))) },
            {
              titulo: 'Archivos',
              celda: (f) => {
                const celda = h('div.fila');
                celda.append(
                  boton('PDF y XML', async () => {
                    const archivos = await llamar('archivos_de_factura', { folio: String(f.folio) });
                    reemplazar(celda, archivosDeFactura(archivos));
                  }),
                );
                return celda;
              },
            },
          ],
          facturas,
        ),
    facturas.length > 0 ? h('p.chico.tenue', null, 'Los enlaces de PDF y XML caducan en 60 segundos; ábralos en cuanto aparezcan.') : null,
  );
}

function vistaFactura(d: D): Hijo {
  return tarjeta(
    h('div.encabezado', null, h('h1', null, `Factura ${texto(d.folio)}`), h('span.precio', null, dinero(d.total))),
    h('dl', null, h('dt', null, 'Emisión'), h('dd', null, fecha(d.issued_on)), d.uuid ? [h('dt', null, 'UUID fiscal'), h('dd', null, String(d.uuid))] : null),
    archivosDeFactura(d),
    h('p.chico.tenue', null, 'Los enlaces caducan en 60 segundos.'),
  );
}

const RESULTADO: Record<string, [string, Tono]> = { ok: ['Cumple', 'bien'], attention: ['Atención', 'alerta'], out: ['Fuera de norma', 'mal'], no_data: ['Sin dato', ''] };
const estadoResultado = (estado: unknown) => {
  const [rotulo, tono] = RESULTADO[String(estado)] ?? [texto(estado), ''];
  return insignia(rotulo, tono);
};

function vistaResultados(d: D): Hijo {
  const puntos = lista(d.points);
  if (puntos.length === 0) return tarjeta(h('h1', null, 'Resultados de laboratorio'), h('p.tenue', null, 'No hay resultados publicados.'));
  return puntos.map((p) => {
    const muestra: D | null = p.sample ?? null;
    const limites = (x: D) => (numero(x.min) !== null && numero(x.max) !== null ? `${x.min} – ${x.max}` : numero(x.max) !== null ? `≤ ${x.max}` : numero(x.min) !== null ? `≥ ${x.min}` : '—');
    return tarjeta(
      h('div.encabezado', null, h('div.pila', null, h('h1', null, texto(p.point)), h('span.chico.tenue', null, [p.property, p.water_type].filter(Boolean).join(' · '))), muestra ? estadoResultado(muestra.status) : null),
      muestra
        ? [
            h('p.chico.tenue', null, `Muestra ${texto(muestra.folio)}${muestra.published_at ? ` · publicada ${fecha(String(muestra.published_at))}` : ''}`),
            tabla(
              [
                { titulo: 'Parámetro', celda: (x) => texto(x.name) },
                { titulo: 'Valor', celda: (x) => `${texto(x.value)}${x.unit ? ` ${x.unit}` : ''}`, num: true },
                { titulo: 'Límites', celda: limites, num: true },
                { titulo: 'Resultado', celda: (x) => estadoResultado(x.status) },
              ],
              lista(muestra.parameters),
            ),
          ]
        : h('p.tenue', null, 'Sin resultados publicados para este punto.'),
    );
  });
}

function vistaSolicitud(d: D): Hijo {
  return tarjeta(h('div.encabezado', null, h('h1', null, `Solicitud ${texto(d.folio)}`), insignia(d.status === 'new' ? 'Recibida' : texto(d.status), 'bien')), aviso(String(d.message ?? 'Solicitud creada. El equipo de Eytra la verá en su bandeja y le dará seguimiento.'), 'bien'));
}

const ATENCION: Record<string, string> = {
  overdue: 'Facturas vencidas', out_of_norm: 'Muestras fuera de norma', ending: 'Igualas por terminar', low_stock: 'Inventario bajo mínimo', unassigned: 'Solicitudes sin asignar',
};
const DEL_RESUMEN = new Set(['period', 'billed', 'collected', 'receivable', 'subscriptions', 'lab', 'inventory', 'requests', 'attention', 'chart', 'today']);

function vistaResumen(d: D): Hijo {
  const cuenta = (v: unknown) => (numero(v) ?? 0).toLocaleString('es-MX');
  const anterior = (x: D) => (numero(x.previous) !== null ? `Periodo anterior: ${dinero(x.previous)}` : undefined);
  const hoy = d.period?.today ?? d.today;
  const { billed: f, collected: c, receivable: r, subscriptions: s, lab: l, inventory: i, requests: q } = d as Record<string, D | undefined>;
  const atencion = Object.entries((d.attention ?? {}) as D).filter(([, v]) => Array.isArray(v) && v.length > 0);
  const otras = Object.entries(d).filter(([k, v]) => !DEL_RESUMEN.has(k) && v !== null && typeof v === 'object');
  return [
    tarjeta(
      h('div.encabezado', null, h('h1', null, 'Resumen del día'), hoy ? h('span.chico.tenue', null, fecha(String(hoy))) : null),
      h(
        'div.cifras',
        null,
        f ? cifra('Facturado', dinero(f.current), '', anterior(f)) : null,
        c ? cifra('Cobrado', dinero(c.current), '', anterior(c)) : null,
        r ? cifra('Por cobrar', dinero(r.total), '', `${cuenta(r.count)} facturas abiertas`) : null,
        r ? cifra('Vencido', dinero(r.overdue), (numero(r.overdue) ?? 0) > 0 ? 'mal' : '', `${cuenta(r.overdue_count)} vencidas`) : null,
        s ? cifra('Igualas activas', cuenta(s.active), '', `${dinero(s.monthly)} al mes · ${cuenta(s.ending_count)} por terminar`) : null,
        l ? cifra('Muestras en laboratorio', cuenta(l.in_lab), '', `${cuenta(l.to_validate)} por validar`) : null,
        l ? cifra('Fuera de norma', cuenta(l.out_of_norm), (numero(l.out_of_norm) ?? 0) > 0 ? 'mal' : '') : null,
        i ? cifra('Inventario bajo mínimo', cuenta(i.low_count), (numero(i.low_count) ?? 0) > 0 ? 'mal' : '') : null,
        q ? cifra('Solicitudes sin asignar', cuenta(q.unassigned)) : null,
      ),
    ),
    atencion.map(([k, v]) => tarjeta(h('h2', null, ATENCION[k] ?? etiqueta(k)), generico(v, k))),
    // Lo que la API agregue después se muestra tal cual, sin esperar a esta vista.
    otras.map(([k, v]) => tarjeta(h('h2', null, etiqueta(k)), generico(v, k))),
  ];
}

const COTIZACION: Record<string, [string, Tono]> = {
  draft: ['Borrador', 'alerta'], sent: ['Enviada', ''], in_review: ['En revisión', 'alerta'], approved: ['Aprobada', 'bien'], converted: ['Convertida en pedido', 'bien'], rejected: ['Rechazada', 'mal'],
};

function vistaCotizacion(d: D): Hijo {
  const [rotulo, tono] = COTIZACION[String(d.status)] ?? [texto(d.status), ''];
  const partidas = lista(d.lines);
  const cliente: D = d.client ?? {};
  const pendientes = numero(d.pending_prices) ?? 0;
  return tarjeta(
    h('div.encabezado', null, h('h1', null, `Cotización ${texto(d.folio)}`), insignia(rotulo, tono)),
    d.duplicate ? aviso('Esta cotización ya existía: no se creó otra.', 'alerta') : null,
    h(
      'dl',
      null,
      cliente.name ? [h('dt', null, 'Cliente'), h('dd', null, texto(cliente.name), cliente.prospect ? [' ', insignia('Prospecto')] : null)] : null,
      d.contact_name ? [h('dt', null, 'Contacto'), h('dd', null, [d.contact_name, d.contact_email].filter(Boolean).join(' · '))] : null,
      d.template ? [h('dt', null, 'Formato'), h('dd', null, etiqueta(String(d.template)))] : null,
      d.valid_until ? [h('dt', null, 'Vigencia'), h('dd', null, fecha(String(d.valid_until)))] : null,
    ),
    partidas.length > 0
      ? tabla(
          [
            { titulo: 'Partida', celda: (l) => h('div.pila', null, h('span', null, texto(l.description)), l.code || l.note ? h('span.chico.tenue', null, [l.code, l.note].filter(Boolean).join(' · ')) : null) },
            { titulo: 'Cantidad', celda: (l) => `${texto(l.quantity)}${l.unit ? ` ${l.unit}` : ''}`, num: true },
            { titulo: 'Precio', celda: (l) => (l.price_pending ? insignia('Por cotizar', 'alerta') : dinero(l.unit_price)), num: true },
            { titulo: 'Importe', celda: (l) => (l.price_pending ? '—' : dinero(l.amount)), num: true },
          ],
          partidas,
        )
      : null,
    d.total !== undefined ? h('dl.totales', null, h('dt', null, 'Subtotal'), h('dd', null, dinero(d.subtotal)), h('dt', null, 'IVA'), h('dd', null, dinero(d.tax)), h('dt.total', null, 'Total'), h('dd.total', null, dinero(d.total))) : null,
    pendientes > 0 ? aviso(`${pendientes} ${pendientes === 1 ? 'partida queda' : 'partidas quedan'} sin precio para que el equipo ${pendientes === 1 ? 'la' : 'las'} cotice.`, 'alerta') : null,
    d.status === 'draft' ? h('p.chico.tenue', null, 'Está en borrador: no se envía al cliente hasta que el equipo la revise y la apruebe en el CMS.') : null,
    d.url ? h('div.fila', null, boton('Revisar en el CMS', () => abrir(d.url), 'principal')) : null,
  );
}

// ───────────────────────── Arranque ─────────────────────────

const VISTAS: Record<string, (datos: D, argumentos: D) => Hijo> = {
  buscar_en_sitio: vistaBusqueda,
  leer_pagina: vistaPagina,
  datos_de_contacto: vistaContacto,
  catalogo_de_productos: vistaCatalogo,
  envios_devoluciones_y_pagos: vistaTienda,
  articulos_del_blog: vistaBlog,
  leer_articulo: vistaArticulo,
  documentos: vistaDocumentos,
  leer_documento: vistaDocumento,
  mi_cuenta: vistaCuenta,
  estado_de_cuenta: vistaEstadoDeCuenta,
  archivos_de_factura: vistaFactura,
  resultados_de_laboratorio: vistaResultados,
  crear_solicitud: vistaSolicitud,
  resumen_del_dia: vistaResumen,
  crear_cotizacion: vistaCotizacion,
  estado_de_cotizacion: vistaCotizacion,
};

// El servidor escribe en <html data-vista> qué herramienta abre esta vista (cada una tiene su recurso ui://);
// si faltara, se toma del contexto que manda el cliente.
let vista = document.documentElement.dataset.vista ?? '';
if (!(vista in VISTAS)) vista = '';
let argumentos: D = {};

function pintar(lectura: Lectura) {
  let contenido: Hijo;
  if (!lectura.ok) contenido = tarjeta(aviso(lectura.error, 'mal'));
  else {
    try {
      contenido = (VISTAS[vista] ?? ((d: D) => tarjeta(generico(d))))(lectura.datos, argumentos);
    } catch (error) {
      console.error('[vista]', error);
      contenido = tarjeta(aviso('No se pudo mostrar esta respuesta.', 'mal'), generico(lectura.datos));
    }
  }
  reemplazar(raiz, contenido);
}

function aplicarContexto(contexto: McpUiHostContext | undefined) {
  if (!contexto) return;
  if (contexto.theme) applyDocumentTheme(contexto.theme);
  if (contexto.styles?.variables) applyHostStyleVariables(contexto.styles.variables);
  if (contexto.styles?.css?.fonts) applyHostFonts(contexto.styles.css.fonts);
  const margen = contexto.safeAreaInsets;
  if (margen) document.body.style.padding = `${margen.top}px ${margen.right}px ${margen.bottom}px ${margen.left}px`;
  const nombre = contexto.toolInfo?.tool?.name;
  if (!vista && typeof nombre === 'string' && nombre in VISTAS) vista = nombre;
}

app.ontoolinput = (parametros) => {
  argumentos = (parametros.arguments as D | undefined) ?? {};
};
app.ontoolresult = (resultado) => pintar(leer(resultado));
app.ontoolcancelled = () => pintar({ ok: false, error: 'La consulta se canceló.' });
app.onhostcontextchanged = aplicarContexto;
app.onteardown = async () => ({});

app
  .connect()
  .then(() => aplicarContexto(app.getHostContext()))
  .catch((error: unknown) => {
    console.error('[vista] sin conexión con el cliente', error);
    raiz.replaceChildren(aviso('Esta vista solo funciona dentro de un cliente compatible con MCP Apps.', 'alerta'));
  });
