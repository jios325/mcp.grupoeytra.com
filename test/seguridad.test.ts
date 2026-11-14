import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { describe, test } from 'node:test';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { Almacen } from '../src/auth/almacen.js';
import { avisosDeConfig } from '../src/config.js';
import { Sitio } from '../src/publico/sitio.js';
import { abrirLogin, form, levantar, llamada, registrar, rpc, tokenPara } from './apoyo.js';

// Regresiones de la auditoría de seguridad del 14 nov 2026. Cada prueba fija el invariante que un
// hallazgo rompía; cada una levanta su propia app para no compartir límites ni transacciones.

const DIAS_30 = 30 * 24 * 60 * 60_000;
const verificador = () => randomBytes(32).toString('base64url');

describe('refresh tokens', () => {
  test('un refresh ya rotado sigue delatando el reúso después de la limpieza horaria', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const almacen = new Almacen(':memory:');
    const datos = { familia: 'f', client_id: 'c', usuario_id: 'u', aal: 'aal2' as const, scope: 'eytra' };
    // Quien copió el token lo rota primero y se queda con el sucesor.
    const copiado = almacen.emitirRefresh({ ...datos, vence: Date.now() + DIAS_30 });
    assert.equal(almacen.usarRefresh(copiado).ok, true);
    const sucesor = almacen.emitirRefresh({ ...datos, vence: Date.now() + DIAS_30 });
    t.mock.timers.tick(2 * 60 * 60_000);
    almacen.limpiar();
    // El cliente legítimo presenta el suyo horas después: debe cerrar la sesión entera.
    assert.deepEqual(almacen.usarRefresh(copiado), { ok: false, motivo: 'reusado' });
    assert.equal(almacen.verRefresh(sucesor), null);
    almacen.cerrar();
  });

  test('dos renovaciones simultáneas con el mismo refresh no dejan una sesión viva', async () => {
    const app = await levantar();
    try {
      const t = await tokenPara(app.base, 'cliente@x.test');
      let abrir!: () => void;
      app.asistente.enEspera = 0;
      app.asistente.compuerta = new Promise((ok) => {
        abrir = ok;
      });
      const renovar = (refresh: string) => fetch(`${app.base}/token`, form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: t.clientId }));
      const enVuelo = [renovar(t.refresh_token), renovar(t.refresh_token)];
      while (app.asistente.enEspera < 2) await new Promise((ok) => setTimeout(ok, 5));
      app.asistente.compuerta = null;
      abrir();
      const respuestas = await Promise.all(enVuelo);
      assert.ok(respuestas.some((r) => r.status === 400), 'el reúso simultáneo debe detectarse');
      // Lo que se haya emitido en la carrera pertenece a una familia revocada: no debe servir.
      for (const r of respuestas) {
        if (r.status !== 200) continue;
        const { refresh_token } = (await r.json()) as { refresh_token: string };
        assert.equal((await renovar(refresh_token)).status, 400);
      }
    } finally {
      app.cerrar();
    }
  });
});

describe('topes de intentos en el login', () => {
  test('los códigos simultáneos no rebasan el tope de 5 fallos por cuenta', async () => {
    const app = await levantar();
    try {
      app.login.retardoMs = 40;
      const tx = await abrirLogin(app.base, await registrar(app.base), verificador());
      const paso = await fetch(`${app.base}/authorize`, form({ tx, paso: 'contrasena', correo: 'equipo@x.test', contrasena: 'bien' }));
      assert.equal(paso.status, 200);
      const intentos = await Promise.all(Array.from({ length: 9 }, (_, i) => fetch(`${app.base}/authorize`, form({ tx, paso: 'codigo', codigo: String(100_000 + i) }))));
      assert.ok(app.login.codigos <= 5, `llegaron ${app.login.codigos} códigos a Supabase`);
      assert.equal(intentos.filter((r) => r.status === 429).length, 4);
    } finally {
      app.cerrar();
    }
  });

  test('las contraseñas simultáneas no rebasan el tope de 10 fallos por cuenta y dirección', async () => {
    const app = await levantar();
    try {
      app.login.retardoMs = 40;
      const clientId = await registrar(app.base);
      const transacciones = [await abrirLogin(app.base, clientId, verificador()), await abrirLogin(app.base, clientId, verificador())];
      await Promise.all(
        transacciones.flatMap((tx) => Array.from({ length: 10 }, () => fetch(`${app.base}/authorize`, form({ tx, paso: 'contrasena', correo: 'cliente@x.test', contrasena: 'mal' })))),
      );
      assert.ok(app.login.contrasenas <= 10, `llegaron ${app.login.contrasenas} contraseñas a Supabase`);
    } finally {
      app.cerrar();
    }
  });

  test('diez contraseñas incorrectas desde una dirección no bloquean a la persona en otra', async () => {
    const app = await levantar({ encabezadoIp: 'x-forwarded-for' });
    try {
      const clientId = await registrar(app.base);
      const desde = (ip: string) => ({ 'X-Forwarded-For': ip });
      const ajeno = await abrirLogin(app.base, clientId, verificador());
      for (let i = 0; i < 10; i++) {
        const r = await fetch(`${app.base}/authorize`, form({ tx: ajeno, paso: 'contrasena', correo: 'cliente@x.test', contrasena: 'mal' }, desde('203.0.113.10')));
        assert.equal(r.status, 401);
      }
      // Esa dirección ya no puede seguir probando, ni siquiera con la contraseña correcta.
      const otroAjeno = await abrirLogin(app.base, clientId, verificador());
      assert.equal((await fetch(`${app.base}/authorize`, form({ tx: otroAjeno, paso: 'contrasena', correo: 'cliente@x.test', contrasena: 'bien' }, desde('203.0.113.10')))).status, 429);
      // La persona, desde la suya, entra.
      const propio = await abrirLogin(app.base, clientId, verificador());
      assert.equal((await fetch(`${app.base}/authorize`, form({ tx: propio, paso: 'contrasena', correo: 'cliente@x.test', contrasena: 'bien' }, desde('203.0.113.20')))).status, 302);
    } finally {
      app.cerrar();
    }
  });

  test('repartir los fallos entre direcciones también tiene tope por cuenta', async () => {
    const app = await levantar({ encabezadoIp: 'x-forwarded-for' });
    try {
      const clientId = await registrar(app.base);
      for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
        const tx = await abrirLogin(app.base, clientId, verificador());
        for (let i = 0; i < 10; i++) await fetch(`${app.base}/authorize`, form({ tx, paso: 'contrasena', correo: 'cliente@x.test', contrasena: 'mal' }, { 'X-Forwarded-For': ip }));
      }
      const tx = await abrirLogin(app.base, clientId, verificador());
      const r = await fetch(`${app.base}/authorize`, form({ tx, paso: 'contrasena', correo: 'cliente@x.test', contrasena: 'mal' }, { 'X-Forwarded-For': '198.51.100.4' }));
      assert.equal(r.status, 429);
      assert.equal(app.login.contrasenas, 30);
    } finally {
      app.cerrar();
    }
  });
});

/** POST con encabezados tal cual (fetch normaliza el Content-Type; node:http lo manda como se le da). */
function postCrudo(base: string, encabezados: Record<string, string>, cuerpo: string) {
  return new Promise<{ status: number; texto: string }>((ok, falla) => {
    const peticion = http.request(`${base}/mcp`, { method: 'POST', headers: { ...encabezados, 'Content-Length': Buffer.byteLength(cuerpo) } }, (respuesta) => {
      let texto = '';
      respuesta.setEncoding('utf8');
      respuesta.on('data', (parte: string) => (texto += parte));
      respuesta.on('end', () => ok({ status: respuesta.statusCode ?? 0, texto }));
    });
    peticion.on('error', falla);
    peticion.end(cuerpo);
  });
}

describe('puerta de /mcp', () => {
  test('un cuerpo que Express no analizó no llega a las herramientas', async () => {
    const app = await levantar();
    try {
      // «application/json» + U+00A0: Express no lo reconoce como JSON y el SDK sí.
      const encabezados = { 'Content-Type': 'application/json ', Accept: 'application/json, text/event-stream' };
      const privada = await postCrudo(app.base, encabezados, JSON.stringify(llamada(1, 'estado_de_cuenta')));
      assert.ok([400, 401, 415].includes(privada.status), `respondió ${privada.status}: ${privada.texto.slice(0, 200)}`);
      const publica = await postCrudo(app.base, encabezados, JSON.stringify(llamada(2, 'catalogo_de_productos')));
      assert.ok([400, 415].includes(publica.status), `respondió ${publica.status}`);
      assert.equal(app.cms.pedidos.length, 0);
    } finally {
      app.cerrar();
    }
  });

  test('una persona con sesión no gasta más de 120 llamadas por hora de la llave compartida', async () => {
    const app = await levantar();
    try {
      const { access_token } = await tokenPara(app.base, 'cliente@x.test');
      const lote = (desde: number) => Array.from({ length: 50 }, (_, i) => llamada(desde + i, 'estado_de_cuenta'));
      const sesion = { Authorization: `Bearer ${access_token}` };
      assert.equal((await rpc(app.base, lote(1), sesion)).status, 200);
      assert.equal((await rpc(app.base, lote(51), sesion)).status, 200);
      assert.equal((await rpc(app.base, lote(101), sesion)).status, 429);
      assert.equal(app.asistente.rutas('/account').length, 100);
    } finally {
      app.cerrar();
    }
  });

  test('un visitante no agota desde una dirección el cupo de documentos de todos', async () => {
    const app = await levantar({ encabezadoIp: 'x-forwarded-for' });
    try {
      const pedir = (ip: string, id: number) => rpc(app.base, llamada(id, 'leer_documento', { id: randomUUID() }), { 'X-Forwarded-For': ip });
      const estados: number[] = [];
      for (let i = 1; i <= 35; i++) estados.push((await pedir('198.51.100.7', i)).status);
      assert.equal(estados.filter((s) => s === 429).length, 5);
      assert.equal(app.asistente.rutas('/knowledge').length, 30);
      assert.equal((await pedir('198.51.100.8', 99)).status, 200);
      assert.equal(app.asistente.rutas('/knowledge').length, 31);
    } finally {
      app.cerrar();
    }
  });

  test('no anuncia avisos de cambio de herramientas: no hay flujos de escucha que dejar abiertos', async () => {
    const app = await levantar();
    try {
      const c = new Client({ name: 'prueba', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`)));
      const capacidades = c.getServerCapabilities();
      assert.ok(capacidades?.tools, 'el servidor anuncia herramientas');
      assert.equal(capacidades.tools.listChanged, false);
      await c.close();
    } finally {
      app.cerrar();
    }
  });
});

describe('configuración', () => {
  test('avisa cuando escucha detrás de un proxy sin encabezado de IP', () => {
    assert.equal(avisosDeConfig({ host: '0.0.0.0', encabezadoIp: null }).length, 1);
    assert.equal(avisosDeConfig({ host: '0.0.0.0', encabezadoIp: 'x-forwarded-for' }).length, 0);
    assert.equal(avisosDeConfig({ host: '127.0.0.1', encabezadoIp: null }).length, 0);
  });
});

describe('lectura del sitio', () => {
  test('deja de descargar al llegar al tope aunque la respuesta no declare su tamaño', async (t) => {
    const bloque = new Uint8Array(64 * 1024).fill(0x61);
    let entregados = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      const cuerpo = new ReadableStream<Uint8Array>({
        pull(control) {
          if (entregados >= 6 * 1024 * 1024) return control.close();
          entregados += bloque.byteLength;
          control.enqueue(bloque);
        },
      });
      return new Response(cuerpo, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const pagina = await new Sitio('https://grupoeytra.com').leerPagina('/pesada');
    assert.equal(pagina.ok, true);
    assert.ok(entregados <= 2 * 1024 * 1024 + 4 * bloque.byteLength, `se descargaron ${entregados} bytes`);
  });

  test('no hace más de 8 descargas a la vez', async (t) => {
    let enCurso = 0;
    let maximo = 0;
    let soltar!: () => void;
    const espera = new Promise<void>((ok) => {
      soltar = ok;
    });
    t.mock.method(globalThis, 'fetch', async () => {
      enCurso += 1;
      maximo = Math.max(maximo, enCurso);
      await espera;
      enCurso -= 1;
      return new Response('<html><body><main>hola</main></body></html>', { status: 200 });
    });
    const sitio = new Sitio('https://grupoeytra.com');
    const lecturas = Array.from({ length: 30 }, () => sitio.leerPagina('/x'));
    await new Promise((ok) => setTimeout(ok, 20));
    soltar();
    const resultados = await Promise.all(lecturas);
    assert.ok(maximo <= 8, `hubo ${maximo} descargas simultáneas`);
    assert.equal(resultados.filter((r) => r.ok).length, 8);
  });
});
