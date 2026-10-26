import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Almacen } from '../src/auth/almacen.js';
import { redirectRegistrado, redirectValido, s256 } from '../src/auth/oauth.js';
import { Tokens } from '../src/auth/tokens.js';
import { esProtegida } from '../src/herramientas.js';
import { buscarEntradas, extraerTexto, leerLlmsTxt, Sitio } from '../src/publico/sitio.js';

const HOSTS = ['claude.ai', 'claude.com'];

const LLMS = `# Grupo Eytra

> Empresa de tratamiento de agua.

## Laboratorio y normas

- [Laboratorio de análisis de agua](https://grupoeytra.com/laboratorio): análisis fisicoquímicos y microbiológicos.
- [NOM-245-SSA1-2010](https://grupoeytra.com/laboratorio/nom-245-ssa1): requisitos sanitarios del agua de albercas.

## Recursos

- [Prevención de Legionella en hoteles](https://grupoeytra.com/blog/prevencion-legionella-hoteles-guia-completa): guía de control.
`;

test('llms.txt: lee enlaces con su sección y busca sin acentos', () => {
  const entradas = leerLlmsTxt(LLMS);
  assert.equal(entradas.length, 3);
  assert.deepEqual(entradas[1], {
    titulo: 'NOM-245-SSA1-2010',
    url: 'https://grupoeytra.com/laboratorio/nom-245-ssa1',
    descripcion: 'requisitos sanitarios del agua de albercas.',
    seccion: 'Laboratorio y normas',
  });
  assert.equal(buscarEntradas(entradas, 'análisis')[0]?.url, 'https://grupoeytra.com/laboratorio');
  assert.equal(buscarEntradas(entradas, 'legionella HOTELES')[0]?.seccion, 'Recursos');
  assert.equal(buscarEntradas(entradas, 'albercas')[0]?.titulo, 'NOM-245-SSA1-2010');
  assert.deepEqual(buscarEntradas(entradas, 'tornillos'), []);
});

test('leer páginas: solo el dominio del sitio', () => {
  const sitio = new Sitio('https://grupoeytra.com');
  assert.equal(sitio.resolver('/laboratorio')?.toString(), 'https://grupoeytra.com/laboratorio');
  assert.equal(sitio.resolver('https://www.grupoeytra.com/contacto#form')?.toString(), 'https://www.grupoeytra.com/contacto');
  assert.equal(sitio.resolver('https://evil.example/laboratorio'), null);
  assert.equal(sitio.resolver('//evil.example/x'), null);
  assert.equal(sitio.resolver('https://grupoeytra.com.evil.example/'), null);
  assert.equal(sitio.resolver('file:///etc/passwd'), null);
  assert.equal(sitio.resolver('javascript:alert(1)'), null);
  assert.equal(sitio.resolver('https://grupoeytra.com:8081/'), null);
  assert.equal(sitio.resolver('http://grupoeytra.com/laboratorio'), null);
  assert.equal(sitio.resolver('https://usuario:clave@grupoeytra.com/'), null);
});

test('texto de una página: main sin menú, scripts ni formularios', () => {
  const html = `<html><head><title>Laboratorio | Grupo Eytra</title><meta name="description" content="Análisis de agua"></head>
  <body><header><nav>Menú</nav></header><main><h1>Laboratorio</h1><p>Análisis &amp; muestreo&nbsp;con cadena de custodia.</p>
  <ul><li>NOM-127</li><li>NOM-245</li></ul><script>alert(1)</script><form><input name="x">Formulario</form>
  <table><tr><th>Parámetro</th><th>Límite</th></tr><tr><td>Cloro</td><td>1.5</td></tr></table></main><footer>Pie</footer></body></html>`;
  const { titulo, descripcion, texto } = extraerTexto(html);
  assert.equal(titulo, 'Laboratorio | Grupo Eytra');
  assert.equal(descripcion, 'Análisis de agua');
  assert.match(texto, /^# Laboratorio/);
  assert.match(texto, /Análisis & muestreo con cadena de custodia\./);
  assert.match(texto, /- NOM-127/);
  assert.match(texto, /Cloro \| 1\.5/);
  for (const fuera of ['Menú', 'alert', 'Formulario', 'Pie']) assert.doesNotMatch(texto, new RegExp(fuera));
});

test('redirect URIs: https o http en loopback, y loopback sin importar el puerto', () => {
  assert.equal(redirectValido('https://claude.ai/api/mcp/auth_callback', HOSTS), true);
  assert.equal(redirectValido('http://localhost:33418/callback', HOSTS), true);
  assert.equal(redirectValido('http://127.0.0.1/callback', HOSTS), true);
  assert.equal(redirectValido('http://evil.example/callback', HOSTS), false);
  assert.equal(redirectValido('https://evil.example/callback', HOSTS), false);
  assert.equal(redirectValido('https://claude.com/api/mcp/auth_callback', HOSTS), true);
  assert.equal(redirectValido('https://claude.ai:8443/cb', HOSTS), false);
  assert.equal(redirectValido('https://claude.ai/cb#x', HOSTS), false);
  assert.equal(redirectValido('javascript:alert(1)', HOSTS), false);

  const cliente = { client_id: 'c', client_name: 'x', creado: 0, redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback'] };
  assert.equal(redirectRegistrado(cliente, 'https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(redirectRegistrado(cliente, 'https://claude.ai/api/mcp/auth_callback?x=1'), false);
  assert.equal(redirectRegistrado(cliente, 'http://localhost:51234/callback'), true);
  assert.equal(redirectRegistrado(cliente, 'http://localhost:51234/otra'), false);
  assert.equal(redirectRegistrado(cliente, 'http://127.0.0.1:51234/callback'), false);
});

test('PKCE S256: SHA-256 en base64url sin relleno (comparado con WebCrypto)', async () => {
  const verificador = 'un-verificador_de-prueba.con~los-caracteres-que-permite-el-RFC';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador)));
  const esperado = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(s256(verificador), esperado);
  assert.doesNotMatch(s256(verificador), /[+/=]/);
});

test('códigos de un solo uso y refresh con rotación y detección de reúso', () => {
  const almacen = new Almacen(':memory:');
  almacen.guardarCodigo('codigo-1', { client_id: 'c', usuario_id: 'u', redirect_uri: 'https://x', code_challenge: 'h', scope: 'eytra', vence: Date.now() + 60_000 });
  assert.equal(almacen.canjearCodigo('codigo-1')?.usuario_id, 'u');
  assert.equal(almacen.canjearCodigo('codigo-1'), null);

  almacen.guardarCodigo('viejo', { client_id: 'c', usuario_id: 'u', redirect_uri: 'https://x', code_challenge: 'h', scope: 'eytra', vence: Date.now() - 1 });
  assert.equal(almacen.canjearCodigo('viejo'), null);

  const r1 = almacen.emitirRefresh({ familia: 'f', client_id: 'c', usuario_id: 'u', scope: 'eytra', vence: Date.now() + 60_000 });
  const uso = almacen.usarRefresh(r1);
  assert.equal(uso.ok, true);
  const r2 = almacen.emitirRefresh({ familia: 'f', client_id: 'c', usuario_id: 'u', scope: 'eytra', vence: Date.now() + 60_000 });
  // Reusar r1 revoca toda la familia, también r2.
  assert.deepEqual(almacen.usarRefresh(r1), { ok: false, motivo: 'reusado' });
  assert.deepEqual(almacen.usarRefresh(r2), { ok: false, motivo: 'no_existe' });
  almacen.cerrar();
});

test('access tokens: solo los nuestros y para este recurso', async () => {
  const secreto = 'x'.repeat(40);
  const tokens = new Tokens(secreto, 'https://mcp.grupoeytra.com', 'https://mcp.grupoeytra.com/mcp');
  const token = await tokens.firmar('usuario-1', 'cliente-1', 'eytra');
  assert.deepEqual(await tokens.verificar(token).then((s) => s && { u: s.usuarioId, c: s.clientId }), { u: 'usuario-1', c: 'cliente-1' });
  const otroRecurso = new Tokens(secreto, 'https://mcp.grupoeytra.com', 'https://otro.example/mcp');
  assert.equal(await otroRecurso.verificar(token), null);
  const otroSecreto = new Tokens('y'.repeat(40), 'https://mcp.grupoeytra.com', 'https://mcp.grupoeytra.com/mcp');
  assert.equal(await otroSecreto.verificar(token), null);
  assert.equal(await tokens.verificar(`${token}x`), null);
});

test('herramientas protegidas', () => {
  assert.equal(esProtegida('estado_de_cuenta'), true);
  assert.equal(esProtegida('buscar_en_sitio'), false);
  assert.equal(esProtegida('toString'), false);
  assert.equal(esProtegida(undefined), false);
});
