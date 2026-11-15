import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { CON_VISTA, dominioParaClaude, esOtroCliente, uriDeVista, type HerramientaConVista } from '../src/vistas.js';
import * as apoyo from './apoyo.js';
import type { AppDePrueba } from './apoyo.js';

// MCP Apps: cada herramienta anuncia su vista ui:// y el recurso entrega el HTML empaquetado.

let app: AppDePrueba;
let base = '';

before(async () => {
  app = await apoyo.levantar();
  ({ base } = app);
});

after(() => app.cerrar());

async function cliente(token?: string, agente?: string, origen = base) {
  const c = new Client({ name: 'prueba', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${origen}/mcp`), { requestInit: { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(agente ? { 'User-Agent': agente } : {}) } } }));
  return c;
}

type MetaDeVista = { ui?: { resourceUri?: string }; 'ui/resourceUri'?: string } | undefined;

describe('vistas (MCP Apps)', () => {
  test('cada herramienta apunta a su recurso ui://, con la llave actual y la anterior', async () => {
    const c = await cliente();
    const { tools } = await c.listTools();
    // Las de lectura larga van sin vista: son texto para el modelo.
    const sinVista = tools.filter((t) => !(CON_VISTA as readonly string[]).includes(t.name));
    assert.deepEqual(sinVista.map((t) => t.name).sort(), ['leer_articulo', 'leer_pagina']);
    assert.ok(sinVista.every((t) => (t._meta as MetaDeVista)?.ui === undefined));
    const conVista = tools.filter((t) => !sinVista.includes(t));
    assert.deepEqual(conVista.map((t) => t.name).sort(), [...CON_VISTA].sort());
    for (const t of conVista) {
      const meta = t._meta as MetaDeVista;
      const uri = uriDeVista(t.name as HerramientaConVista);
      assert.equal(meta?.ui?.resourceUri, uri, t.name);
      assert.equal(meta?.['ui/resourceUri'], uri, t.name);
    }
    await c.close();
  });

  test('los recursos se listan y se leen sin sesión, como HTML de MCP Apps', async () => {
    const c = await cliente();
    const { resources } = await c.listResources();
    assert.deepEqual(resources.map((r) => r.uri).sort(), CON_VISTA.map(uriDeVista).sort());
    assert.ok(resources.every((r) => r.mimeType === 'text/html;profile=mcp-app'));

    const uri = uriDeVista('estado_de_cuenta');
    const { contents } = await c.readResource({ uri });
    const [contenido] = contents as { uri: string; mimeType?: string; text?: string }[];
    assert.equal(contenido?.uri, uri);
    assert.equal(contenido?.mimeType, 'text/html;profile=mcp-app');
    const html = contenido?.text ?? '';
    assert.match(html, /^<!doctype html>\n<html lang="es-MX" data-vista="estado_de_cuenta">/);
    assert.ok(!html.includes('__VISTA__'), 'el marcador se sustituye');
    await c.close();
  });

  test('la vista va en un solo archivo: sin scripts, estilos ni imágenes de fuera', async () => {
    const c = await cliente();
    const { contents } = await c.readResource({ uri: uriDeVista('catalogo_de_productos') });
    const html = (contents[0] as { text?: string }).text ?? '';
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /<link[^>]+href=/i);
    assert.doesNotMatch(html, /<img[^>]+src=/i);
    // Un </script> dentro del paquete cerraría la etiqueta antes de tiempo.
    assert.equal(html.match(/<\/script>/gi)?.length, 1);
    await c.close();
  });

  test('con sesión solo se anuncian las herramientas de la persona, cada una con su vista', async () => {
    const { access_token: token } = await apoyo.tokenPara(base, 'cliente@x.test');
    const c = await cliente(token);
    const { tools } = await c.listTools();
    assert.ok(tools.some((t) => t.name === 'estado_de_cuenta'));
    assert.ok(!tools.some((t) => t.name === 'resumen_del_dia'));
    assert.equal(typeof (tools.find((t) => t.name === 'estado_de_cuenta')?._meta as MetaDeVista)?.ui?.resourceUri, 'string');
    await c.close();
  });

  test('el resultado para el modelo no cambia: sigue siendo el JSON en texto', async () => {
    const c = await cliente();
    const r = await c.callTool({ name: 'catalogo_de_productos', arguments: {} });
    const texto = (r.content as { type: string; text: string }[])[0]?.text ?? '';
    assert.equal(typeof JSON.parse(texto), 'object');
    assert.equal(r.structuredContent, undefined);
    await c.close();
  });

  test('el origen para Claude sale de la URL del conector, como en su documentación', async () => {
    // Ejemplo de claude.com/docs/connectors/building/mcp-apps/getting-started.
    assert.equal(dominioParaClaude('https://example.com/mcp'), 'c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com');
    assert.equal(dominioParaClaude('http://localhost:8330/mcp'), null);
    assert.equal(esOtroCliente('claude-ai', 'Claude-User'), false);
    assert.equal(esOtroCliente(undefined, undefined), false);
    assert.equal(esOtroCliente('ChatGPT', null), true);
    assert.equal(esOtroCliente(null, 'Visual Studio Code/1.99'), true);

    const remota = await apoyo.levantar({ recurso: 'https://example.com/mcp' });
    try {
      const dominioDe = async (agente: string) => {
        const c = await cliente(undefined, agente, remota.base);
        const { contents } = await c.readResource({ uri: uriDeVista('estado_de_cuenta') });
        await c.close();
        return (contents[0] as { _meta?: { ui?: { domain?: string } } })._meta?.ui?.domain;
      };
      assert.equal(await dominioDe('Claude-User'), 'c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com');
      // El formato es de cada cliente: a uno que se identifica como otro no se le manda el de Claude.
      assert.equal(await dominioDe('openai-mcp/1.0.0'), undefined);
    } finally {
      remota.cerrar();
    }

    // En local (http) no hay URL que Claude pueda validar.
    const c = await cliente(undefined, 'Claude-User');
    const { contents } = await c.readResource({ uri: uriDeVista('estado_de_cuenta') });
    assert.equal((contents[0] as { _meta?: unknown })._meta, undefined);
    await c.close();
  });
});
