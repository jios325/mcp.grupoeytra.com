import { createHash } from 'node:crypto';

import { registerAppResource, RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';

import { HTML_VISTA } from './vista.generada.js';

// MCP Apps (extensión io.modelcontextprotocol/ui): cada herramienta de esta lista apunta a un recurso ui://
// con la vista que el cliente dibuja en la conversación. Un cliente sin soporte ignora `_meta.ui` y recibe
// el mismo texto de siempre, así que nada cambia para él.
// La vista es un solo HTML (vista/, empaquetado en vista.generada.ts) y es estática: no lleva datos de nadie.
// Los datos llegan después, por el resultado de la herramienta, que sí pasa por la sesión y los permisos.
// Para quitarle la vista a una herramienta basta con sacarla de esta lista.
// leer_pagina y leer_articulo no la llevan: son texto largo para que el modelo lo lea, y Anthropic
// desaconseja las vistas de contenido largo o estático (guía de diseño de MCP Apps).

export const CON_VISTA = [
  'buscar_en_sitio',
  'datos_de_contacto',
  'catalogo_de_productos',
  'envios_devoluciones_y_pagos',
  'articulos_del_blog',
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

/**
 * Origen estable que Claude le da a la vista: los primeros 32 caracteres hexadecimales del SHA-256 de la
 * URL exacta del conector, en claudemcpcontent.com (docs de Claude, «Set ui.domain for Claude»). Sin él, el
 * origen cambia en cada conversación y hay reportes de vistas que no se dibujan. Solo para conectores
 * remotos: un servidor local no tiene URL que Claude pueda validar.
 */
export function dominioParaClaude(urlDelConector: string): string | null {
  if (!/^https:\/\//i.test(urlDelConector)) return null;
  return `${createHash('sha256').update(urlDelConector).digest('hex').slice(0, 32)}.claudemcpcontent.com`;
}

const OTROS_CLIENTES = /openai|chatgpt|vscode|visual studio|copilot|cursor|goose|postman|mcpjam/i;

/**
 * El formato de `domain` es de cada cliente, así que el de Claude no se le manda a uno que se identifica
 * como otro. El nombre del cliente solo viene en las peticiones de la spec 2026-07-28; en las anteriores el
 * servidor se crea por petición y no lo conoce, y queda el User-Agent. Sin ninguna señal, se manda.
 */
export const esOtroCliente = (nombre?: string | null, agente?: string | null) => OTROS_CLIENTES.test(`${nombre ?? ''} ${agente ?? ''}`);

export function registrarVistas(servidor: McpServer, urlDelConector?: string) {
  const dominio = urlDelConector ? dominioParaClaude(urlDelConector) : null;
  for (const herramienta of CON_VISTA) {
    const uri = uriDeVista(herramienta);
    registerAppResource(servidor, `Vista de ${herramienta}`, uri, { description: `Vista interactiva de la herramienta ${herramienta}.` }, (_uri, extra) => {
      const paraClaude = dominio !== null && !esOtroCliente(servidor.server.getClientVersion()?.name, extra.http?.req?.headers.get('user-agent'));
      return {
        // Sin `_meta.ui.csp`: la vista no carga nada de fuera (ni imágenes ni fuentes), así que se queda
        // con la política por omisión del cliente, que es sin red.
        contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: htmlDeVista(herramienta), ...(paraClaude ? { _meta: { ui: { domain: dominio } } } : {}) }],
      };
    });
  }
}
