// Prueba de humo contra un MCP en marcha (local o staging): herramientas públicas sin sesión y, con
// credenciales, el flujo OAuth completo por el formulario de login y las herramientas de la persona.
//
//   npx tsx scripts/humo.ts http://localhost:8330
//   MCP_HUMO_CORREO=… MCP_HUMO_CONTRASENA=… [MCP_HUMO_TOTP=secreto-base32] npx tsx scripts/humo.ts http://localhost:8330
//
// Las credenciales van solo por variables de entorno y nunca se imprimen.
import { createHash, createHmac, randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.argv[2] ?? 'http://localhost:8330').replace(/\/+$/, '');
const REDIRECT = 'http://localhost:9999/callback';

function totp(secretoBase32: string): string {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretoBase32.replace(/=+$/, '').toUpperCase()) bits += alfabeto.indexOf(c).toString(2).padStart(5, '0');
  const llave = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', llave).update(contador).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const form = (datos: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(datos).toString(),
  redirect: 'manual' as const,
});

async function token(correo: string, contrasena: string, secretoTotp?: string): Promise<string> {
  const registro = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Prueba de humo', redirect_uris: [REDIRECT] }),
  });
  const { client_id } = (await registro.json()) as { client_id: string };
  const verificador = randomBytes(32).toString('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verificador).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'humo',
    resource: `${base}/mcp`,
  });
  const html = await (await fetch(`${base}/authorize?${q}`)).text();
  const tx = /name="tx" value="([^"]+)"/.exec(html)?.[1];
  if (!tx) throw new Error('No apareció el formulario de login');
  let r = await fetch(`${base}/authorize`, form({ tx, paso: 'contrasena', correo, contrasena }));
  if (r.status === 200 && (await r.clone().text()).includes('name="codigo"')) {
    if (!secretoTotp) throw new Error('La cuenta pide código y no hay MCP_HUMO_TOTP');
    r = await fetch(`${base}/authorize`, form({ tx, paso: 'codigo', codigo: totp(secretoTotp) }));
  }
  if (r.status !== 302) {
    const pagina = await r.text();
    const mensaje = /<div class="error"[^>]*>([^<]+)</.exec(pagina)?.[1] ?? /<p>([^<]+)<\/p>/.exec(pagina)?.[1];
    throw new Error(`Login rechazado (${r.status}): ${mensaje ?? 'sin mensaje'}`);
  }
  const code = new URL(r.headers.get('location')!).searchParams.get('code')!;
  const t = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: verificador }));
  const cuerpo = (await t.json()) as { access_token?: string; error_description?: string };
  if (!cuerpo.access_token) throw new Error(`Token rechazado: ${cuerpo.error_description}`);
  return cuerpo.access_token;
}

async function conectar(accessToken?: string) {
  const cliente = new Client({ name: 'humo', version: '1.0.0' });
  await cliente.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), accessToken ? { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  );
  return cliente;
}

function resumir(resultado: unknown): string {
  const r = resultado as { content: { text: string }[]; isError?: boolean };
  const texto = (r.content[0]?.text ?? '').replace(/\s+/g, ' ');
  return `${r.isError ? 'ERROR ' : ''}${texto.slice(0, 160)}${texto.length > 160 ? '…' : ''}`;
}

async function llamar(cliente: Client, nombre: string, args: Record<string, unknown> = {}) {
  try {
    console.log(`  ${nombre}: ${resumir(await cliente.callTool({ name: nombre, arguments: args }))}`);
  } catch (error) {
    console.log(`  ${nombre}: excepción ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`== Sin sesión (${base})`);
const anonimo = await conectar();
console.log(`  herramientas: ${(await anonimo.listTools()).tools.map((t) => t.name).join(', ')}`);
await llamar(anonimo, 'buscar_en_sitio', { consulta: 'legionella hoteles' });
await llamar(anonimo, 'leer_pagina', { ruta: '/laboratorio' });
await llamar(anonimo, 'leer_pagina', { ruta: 'https://example.com/' });
await llamar(anonimo, 'datos_de_contacto');
await llamar(anonimo, 'catalogo_de_productos', { buscar: 'cloro' });
await llamar(anonimo, 'envios_devoluciones_y_pagos');
await llamar(anonimo, 'articulos_del_blog', { limite: 3 });
await llamar(anonimo, 'documentos');
await llamar(anonimo, 'estado_de_cuenta');
await anonimo.close();

const correo = process.env.MCP_HUMO_CORREO;
const contrasena = process.env.MCP_HUMO_CONTRASENA;
if (correo && contrasena) {
  console.log('== Con sesión');
  try {
    const acceso = await token(correo, contrasena, process.env.MCP_HUMO_TOTP);
    const cliente = await conectar(acceso);
    console.log(`  herramientas: ${(await cliente.listTools()).tools.map((t) => t.name).join(', ')}`);
    await llamar(cliente, 'mi_cuenta');
    for (const nombre of ['estado_de_cuenta', 'resultados_de_laboratorio', 'resumen_del_dia', 'documentos']) await llamar(cliente, nombre);
    await llamar(cliente, 'archivos_de_factura', { folio: 'Z-999999' });
    await cliente.close();
  } catch (error) {
    console.log(`  ${error instanceof Error ? error.message : error}`);
  }
}
