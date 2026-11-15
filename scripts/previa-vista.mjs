// Previsualización local de la vista (MCP App) sin Claude ni ChatGPT: una página que hace de cliente con el
// AppBridge oficial de @modelcontextprotocol/ext-apps y le manda a la vista datos de EJEMPLO (sintéticos,
// escritos aquí: no lee .env ni data/, ni llama al CMS). Sirve para revisar cada pantalla al cambiar vista/.
//   npm run vista:previa   →   http://localhost:8332/?vista=estado_de_cuenta&tema=dark
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { construirHtml } from './construir-vista.mjs';

const PUERTO = Number(process.env.PUERTO_PREVIA ?? 8332);

const COTIZACION = {
  id: 'q-1', folio: 'ET-2611642', status: 'draft', template: 'quimicos', approved: false, duplicate: false,
  client: { id: 'c-9', name: 'Hotel Ejemplo', prospect: true }, contact_name: 'Carla Pérez', contact_email: 'carla@example.test',
  subtotal: 2000, tax: 320, total: 2320, pending_prices: 1,
  lines: [
    { description: 'Cloro granulado 25 kg', code: 'CLO-25', quantity: 2, unit: 'Cubeta', unit_price: 1000, amount: 2000, price_pending: false, note: null },
    { description: 'Análisis fisicoquímico NOM-127', code: null, quantity: 1, unit: 'Servicio', unit_price: 0, amount: 0, price_pending: true, note: 'Entrega en Tulum' },
  ],
  created_at: '2026-11-14T16:20:00Z', sent_at: null, valid_until: null, url: 'https://cms.example.test/cotizaciones/q-1',
};

const ARTICULO = {
  slug: 'legionella-en-hoteles', title: 'Legionella en hoteles: qué revisar', topic_name: 'Agua caliente', author_name: 'Ing. Ejemplo', author_role: 'Laboratorio',
  reviewer_name: 'QFB Ejemplo', related_norms: ['NOM-127'], publish_at: '2026-10-02T15:00:00Z',
  body_md: '## Por qué importa\n\nLa **Legionella** crece entre 25 y 45 °C.\n\n- Revise los termotanques\n- Purgue las regaderas poco usadas\n\n### Siguiente paso\n\nConsulte la [guía completa](https://grupoeytra.com/recursos).',
};

const EJEMPLOS = {
  buscar_en_sitio: {
    consulta: 'legionella hoteles',
    paginas: [
      { titulo: 'Control de Legionella', url: 'https://grupoeytra.com/servicios-tratamiento-agua/legionella', descripcion: 'Muestreo, análisis y plan de control para hoteles.', seccion: 'Servicios' },
      { titulo: 'Laboratorio', url: 'https://grupoeytra.com/laboratorio', descripcion: 'Análisis fisicoquímicos y microbiológicos.', seccion: 'Laboratorio' },
    ],
  },
  leer_pagina: { url: 'https://grupoeytra.com/laboratorio', titulo: 'Laboratorio de análisis de agua', descripcion: 'Análisis con validez ante la autoridad.', texto: 'Analizamos agua potable, de alberca y residual.\n\nEntregamos resultados en línea en el portal de clientes.', largo_total: 9000, continuar_desde: 6000 },
  datos_de_contacto: { contacto: { phone: '999 548 5336', whatsapp: '999 548 5336', forms_email: 'contacto@example.test', hours: 'Lunes a viernes, 8:00 a 18:00', delivery_zone: 'Cancún, Riviera Maya y Mérida' }, resumen: 'Tratamiento y análisis de agua en Cancún, Riviera Maya y Mérida.', cotizacion: 'https://grupoeytra.com/cotizacion' },
  catalogo_de_productos: {
    nota: 'Precios de lista en MXN con IVA incluido; descuentos solo con una cotización aprobada por Eytra.', orden: 'destacados', total: 37, hay_mas: true, tienda: 'https://grupoeytra.com/tienda',
    productos: [
      { slug: 'cloro-granulado-25-kg', name: 'Cloro granulado 25 kg', category: 'Químicos', price: 2320, sale_mode: 'unit', recurring_interval: null, pack_quantity: 25, pack_unit: 'kg', summary: 'Hipoclorito de calcio al 65 % para albercas.' },
      { slug: 'plan-alberca', name: 'Plan Alberca', category: 'Planes', price: 1490, sale_mode: 'subscription', recurring_interval: 'mes', pack_quantity: null, pack_unit: null, summary: 'Químicos y visita mensual.' },
      { slug: 'bomba-dosificadora', name: 'Bomba dosificadora', category: 'Equipos', price: 8900, sale_mode: 'unit', recurring_interval: null, pack_quantity: 1, pack_unit: 'pza', summary: 'Dosificación automática de cloro.' },
    ],
  },
  envios_devoluciones_y_pagos: {
    entregas: [
      { key: 'local', name: 'Entrega local', coverage: 'Cancún y Playa del Carmen', cost: 150, free_from: 2500, lead_time: '1 a 2 días hábiles', accepts_chemicals: true },
      { key: 'pickup', name: 'Recolección en sucursal', coverage: 'Cancún', cost: 0, free_from: null, lead_time: 'Mismo día', accepts_chemicals: true },
    ],
    devoluciones: [{ key: 'std', name: 'Productos sin abrir', window_label: '15 días', body: 'Se aceptan en su empaque original.', return_shipping: 'A cargo del cliente' }],
    ajustes: { cutoff_time: '14:00', business_days: 'Lunes a viernes', pickup_address: 'Av. Ejemplo 123, Cancún', payment_methods: 'Tarjeta de crédito o débito', invoice_mode: 'Al pagar', invoice_window: 'Mes en curso', volume_purchases: 'Transferencia bancaria con cotización' },
  },
  articulos_del_blog: {
    articulos: [
      { slug: 'legionella-en-hoteles', title: 'Legionella en hoteles: qué revisar', excerpt: 'Puntos de riesgo y frecuencia de muestreo.', topic_name: 'Agua caliente', author_name: 'Ing. Ejemplo', publish_at: '2026-10-02T15:00:00Z' },
      { slug: 'cloro-libre-vs-total', title: 'Cloro libre contra cloro total', excerpt: 'Cómo leer el resultado de su alberca.', topic_name: 'Albercas', author_name: 'QFB Ejemplo', publish_at: '2026-09-11T15:00:00Z' },
    ],
    temas: [{ slug: 'albercas', name: 'Albercas' }, { slug: 'agua-caliente', name: 'Agua caliente' }],
    url_blog: 'https://grupoeytra.com/blog',
  },
  leer_articulo: ARTICULO,
  documentos: { documents: [{ id: 'd-1', title: 'Ficha técnica: hipoclorito de calcio', visibility: 'public', updated_at: '2026-10-20T12:00:00Z' }, { id: 'd-2', title: 'Procedimiento interno de muestreo', visibility: 'internal', updated_at: '2026-11-01T12:00:00Z' }] },
  leer_documento: { id: 'd-1', title: 'Ficha técnica: hipoclorito de calcio', url: 'https://files.example.test/d-1.pdf' },
  mi_cuenta: { user: { id: 'u-1', name: 'Admin Brisa (prueba)', email: 'admin.brisa@example.test', scope: 'client', role: 'client_admin' }, company: { id: 'c-1', name: 'Condominio Demo Brisa' }, tools: ['account_statement', 'invoice_files', 'lab_results', 'create_request'] },
  estado_de_cuenta: {
    company: 'Condominio Demo Brisa', today: '2026-11-14', total_due: 5220, overdue: 1740, overdue_count: 1,
    invoices: [
      { folio: 'A-101', issued_on: '2026-09-23', due_date: '2026-10-23', total: 1740, balance: 1740, period: 'Septiembre', status: 'vencida' },
      { folio: 'A-123', issued_on: '2026-10-23', due_date: '2026-11-30', total: 3480, balance: 3480, period: 'Octubre', status: 'por_vencer' },
    ],
    last_payment: { paid_on: '2026-09-30', amount: 1740 },
  },
  archivos_de_factura: { folio: 'A-123', uuid: '00000000-0000-4000-8000-000000000123', total: 3480, issued_on: '2026-10-23', status: 'stamped', pdf_url: 'https://files.example.test/A-123.pdf', xml_url: 'https://files.example.test/A-123.xml' },
  resultados_de_laboratorio: {
    points: [
      {
        point: 'Alberca principal', property: 'Torre A', water_type: 'Alberca',
        sample: { folio: 'M-2611-004', published_at: '2026-11-10T18:30:00Z', status: 'out', parameters: [
          { name: 'Cloro libre', value: 0.4, unit: 'mg/L', min: 1, max: 3, status: 'out' },
          { name: 'pH', value: 7.7, unit: '', min: 7.2, max: 7.8, status: 'attention' },
          { name: 'Coliformes totales', value: 0, unit: 'UFC/100 mL', min: null, max: 0, status: 'ok' },
        ] },
      },
      { point: 'Cisterna', property: 'Torre A', water_type: 'Potable', sample: null },
    ],
  },
  crear_solicitud: { id: 'r-1', folio: 'SOL-0412', status: 'new', message: 'Solicitud creada. El equipo de Eytra le dará seguimiento.' },
  resumen_del_dia: {
    period: { key: 'month', today: '2026-11-14', from: '2026-11-01', to: '2026-11-30' },
    billed: { current: 412300, current_count: 58, previous: 405500 }, collected: { current: 365000, previous: 390200 },
    receivable: { total: 286400, count: 31, overdue: 74200, overdue_count: 6 }, subscriptions: { active: 42, monthly: 318000, ending_count: 2 },
    lab: { in_lab: 11, to_validate: 3, out_of_norm: 2 }, inventory: { low_count: 3 }, requests: { unassigned: 4 },
    chart: [{ month: '2026-10', billed: 405500, collected: 390200 }, { month: '2026-11', billed: 412300, collected: 365000 }],
    attention: {
      overdue: [{ id: 'i-1', folio: 'A-101', company: 'Condominio Demo Brisa', balance: 1740, due_date: '2026-10-23' }],
      out_of_norm: [{ id: 's-1', folio: 'M-2611-004', company: 'Condominio Demo Brisa', updated_at: '2026-11-10T18:30:00Z', parameters: ['Cloro libre'] }],
      ending: [],
      low_stock: [{ id: 'p-1', name: 'Cloro granulado', unit: 'kg', min_stock: 100, quantity: 40, ratio: 0.4 }],
      unassigned: [{ id: 'w-1', folio: 'SOL-0412', kind: 'maintenance', created_at: '2026-11-13T15:00:00Z', company: 'Condominio Demo Brisa' }],
    },
  },
  crear_cotizacion: COTIZACION,
  estado_de_cotizacion: { ...COTIZACION, status: 'approved', approved: true, pending_prices: 0, valid_until: '2026-12-14' },
};

// Lado del cliente: el AppBridge oficial, sin servidor MCP detrás; las llamadas de la vista se contestan con los ejemplos.
const anfitrion = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const EJEMPLOS = ${JSON.stringify(EJEMPLOS)};
const parametros = new URLSearchParams(location.search);
const vista = parametros.get('vista') in EJEMPLOS ? parametros.get('vista') : 'estado_de_cuenta';
const tema = parametros.get('tema') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.tema = tema;
const bitacora = document.getElementById('bitacora');
const anotar = (texto) => { bitacora.textContent += texto + '\\n'; };
const menu = document.getElementById('menu');
// leer_pagina y leer_articulo no tienen vista propia: solo se usan para contestar llamadas de otras vistas.
const SIN_VISTA = ['leer_pagina', 'leer_articulo'];
for (const nombre of Object.keys(EJEMPLOS).filter((n) => !SIN_VISTA.includes(n))) {
  const a = document.createElement('a');
  a.href = '?vista=' + nombre + '&tema=' + tema;
  a.textContent = nombre;
  if (nombre === vista) a.setAttribute('aria-current', 'page');
  menu.append(a);
}
document.getElementById('tema').href = '?vista=' + vista + '&tema=' + (tema === 'dark' ? 'light' : 'dark');
const respuesta = (datos) => ({ content: [{ type: 'text', text: JSON.stringify(datos) }] });
const marco = document.getElementById('marco');
const puente = new AppBridge(null, { name: 'Previa Eytra', version: '1.0.0' }, { openLinks: {}, serverTools: {}, logging: {} }, { hostContext: { theme: tema, displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } });
puente.oninitialized = () => {
  anotar('vista lista: ' + vista);
  puente.sendToolInput({ arguments: {} });
  puente.sendToolResult(parametros.get('error') ? { content: [{ type: 'text', text: 'Esta herramienta requiere iniciar sesión con su cuenta de Grupo Eytra.' }], isError: true } : respuesta(EJEMPLOS[vista]));
};
puente.oncalltool = async (p) => {
  anotar('tools/call ' + p.name + ' ' + JSON.stringify(p.arguments ?? {}));
  return p.name in EJEMPLOS ? respuesta(EJEMPLOS[p.name]) : { content: [{ type: 'text', text: 'Herramienta desconocida.' }], isError: true };
};
puente.onrequestdisplaymode = async (p) => { anotar('ui/request-display-mode ' + p.mode); puente.sendHostContextChange({ displayMode: p.mode }); return { mode: p.mode }; };
puente.onopenlink = async (p) => { anotar('ui/open-link ' + p.url); return {}; };
puente.onsizechange = (p) => { if (p.height) marco.style.height = p.height + 'px'; };
await puente.connect(new PostMessageTransport(marco.contentWindow, marco.contentWindow));
// Con srcdoc, como los clientes reales: el HTML del recurso va dentro del iframe aislado, sin navegar a una URL.
marco.srcdoc = await (await fetch('/vista/' + vista)).text();
`;

const paqueteAnfitrion = await build({
  stdin: { contents: anfitrion, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'js' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
});

const pagina = `<!doctype html>
<html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Previa · vista de Grupo Eytra</title>
<style>
  html { color-scheme: light; font: 14px system-ui, sans-serif; } html[data-tema='dark'] { color-scheme: dark; }
  body { margin: 0; padding: 16px; display: grid; gap: 12px; max-width: 980px; background: light-dark(#faf9f5, #262624); color: light-dark(#1a1a18, #f3f2ee); }
  nav { display: flex; flex-wrap: wrap; gap: 6px; } nav a { padding: 2px 8px; border-radius: 999px; border: 1px solid light-dark(#dedcd3, #403e3a); color: inherit; text-decoration: none; font-size: 12px; }
  nav a[aria-current] { background: light-dark(#1a1a18, #f3f2ee); color: light-dark(#fff, #1a1a18); }
  iframe { width: 100%; height: 200px; border: 0; } pre { margin: 0; font-size: 12px; white-space: pre-wrap; opacity: .75; }
</style></head>
<body>
  <nav id="menu"></nav>
  <nav><a id="tema" href="#">Cambiar tema</a></nav>
  <iframe id="marco" title="Vista" sandbox="allow-scripts"></iframe>
  <pre id="bitacora" aria-label="Lo que la vista le pide al cliente"></pre>
  <script type="module" src="/anfitrion.js"></script>
</body></html>`;

// La vista se vuelve a empaquetar en cada carga: basta recargar la página después de cambiar vista/.
createServer(async (peticion, respuesta) => {
  const url = new URL(peticion.url ?? '/', 'http://localhost');
  const vista = /^\/vista\/([a-z_]+)$/.exec(url.pathname)?.[1];
  if (vista) respuesta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end((await construirHtml()).replace('__VISTA__', vista));
  else if (url.pathname === '/anfitrion.js') respuesta.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }).end(paqueteAnfitrion.outputFiles[0].text);
  else if (url.pathname === '/') respuesta.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(pagina);
  else respuesta.writeHead(404).end();
}).listen(PUERTO, '127.0.0.1', () => console.log(`[previa] http://localhost:${PUERTO}/`));
