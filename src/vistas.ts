import { registerAppResource, RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';

import { HTML_VISTA } from './vista.generada.js';

// MCP Apps (extensión io.modelcontextprotocol/ui): cada herramienta de esta lista apunta a un recurso ui://
// con la vista que el cliente dibuja en la conversación. Un cliente sin soporte ignora `_meta.ui` y recibe
// el mismo texto de siempre, así que nada cambia para él.
// La vista es un solo HTML (vista/, empaquetado en vista.generada.ts) y es estática: no lleva datos de nadie.
// Los datos llegan después, por el resultado de la herramienta, que sí pasa por la sesión y los permisos.
// Para quitarle la vista a una herramienta basta con sacarla de esta lista.

export const CON_VISTA = [
  'buscar_en_sitio',
  'leer_pagina',
  'datos_de_contacto',
  'catalogo_de_productos',
  'envios_devoluciones_y_pagos',
  'articulos_del_blog',
  'leer_articulo',
  'documentos',
  'leer_documento',
  'mi_cuenta',
  'estado_de_cuenta',
  'archivos_de_factura',
  'resultados_de_laboratorio',
  'crear_solicitud',
  'resumen_del_dia',
  'crear_cotizacion',
  'estado_de_cotizacion',
] as const;

export type HerramientaConVista = (typeof CON_VISTA)[number];

export const uriDeVista = (herramienta: HerramientaConVista) => `ui://grupo-eytra/${herramienta.replaceAll('_', '-')}.html`;

/** `_meta` de una herramienta con vista: la forma actual (`ui.resourceUri`) y la llave plana de clientes anteriores. */
export function metaDeVista(herramienta: HerramientaConVista) {
  const uri = uriDeVista(herramienta);
  return { ui: { resourceUri: uri }, [RESOURCE_URI_META_KEY]: uri };
}

/** El mismo HTML para todas; solo cambia `data-vista`, que le dice a la vista qué herramienta la abrió. */
export const htmlDeVista = (herramienta: HerramientaConVista) => HTML_VISTA.replace('__VISTA__', herramienta);

export function registrarVistas(servidor: McpServer) {
  for (const herramienta of CON_VISTA) {
    const uri = uriDeVista(herramienta);
    registerAppResource(servidor, `Vista de ${herramienta}`, uri, { description: `Vista interactiva de la herramienta ${herramienta}.` }, () => ({
      // Sin `_meta.ui.csp`: la vista no carga nada de fuera (ni imágenes ni fuentes), así que se queda
      // con la política por omisión del cliente, que es sin red.
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: htmlDeVista(herramienta) }],
    }));
  }
}
