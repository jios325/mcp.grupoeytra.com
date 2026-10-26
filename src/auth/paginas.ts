// Pantallas del inicio de sesión (HTML sin JavaScript, servidas por este mismo servidor). Colores de la
// marca de grupoeytra.com (.claude/rules/diseno-marca.md del sitio): Marino, Niebla y botón Azul CTA.

const escapar = (texto: string) =>
  texto.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function marco(titulo: string, cuerpo: string): string {
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapar(titulo)} · Grupo Eytra</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #EEF1F4; color: #0F1111; font: 15px/1.5 "Noto Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { background: #232F3E; color: #fff; padding: 14px 16px; font-weight: 700; letter-spacing: .2px; }
  header span { color: #38BDF8; }
  main { max-width: 420px; margin: 32px auto; padding: 0 16px; }
  .tarjeta { background: #fff; border: 1px solid #D5D9D9; border-radius: 4px; padding: 24px; }
  h1 { font-size: 20px; line-height: 28px; font-weight: 700; margin: 0 0 8px; }
  p { margin: 0 0 16px; }
  .muted { color: #565959; font-size: 13px; }
  label { display: block; font-weight: 700; margin: 0 0 4px; }
  input { width: 100%; min-height: 44px; padding: 8px 12px; border: 1px solid #888C8C; border-radius: 4px; font: inherit; margin: 0 0 16px; }
  input:focus { outline: 2px solid #0284C7; outline-offset: 1px; }
  button { width: 100%; min-height: 48px; border: 0; border-radius: 4px; background: #0369A1; color: #fff; font: inherit; font-weight: 500; cursor: pointer; }
  button:hover { background: #075985; }
  .error { background: #FDECEA; border: 1px solid #B12704; color: #8A1C00; border-radius: 4px; padding: 10px 12px; margin: 0 0 16px; }
  .app { background: #EEF1F4; border-radius: 4px; padding: 10px 12px; margin: 0 0 16px; font-size: 14px; }
  .app strong { display: block; }
  ul { margin: 0 0 16px; padding-left: 20px; }
</style>
</head>
<body>
<header>Grupo <span>Eytra</span></header>
<main><div class="tarjeta">${cuerpo}</div></main>
</body>
</html>`;
}

function solicitante(cliente: string, destino: string) {
  return `<div class="app"><strong>${escapar(cliente)}</strong>quiere consultar sus datos de Grupo Eytra.<br><span class="muted">Al terminar volverá a ${escapar(destino)}</span></div>`;
}

const alerta = (error?: string) => (error ? `<div class="error" role="alert">${escapar(error)}</div>` : '');

export function paginaLogin(datos: { tx: string; cliente: string; destino: string; error?: string; correo?: string }) {
  return marco(
    'Iniciar sesión',
    `<h1>Iniciar sesión</h1>
${solicitante(datos.cliente, datos.destino)}
<p class="muted">Use la misma cuenta del portal de clientes o del CMS. Solo verá lo que su rol permite.</p>
${alerta(datos.error)}
<form method="post" action="/authorize" autocomplete="on">
  <input type="hidden" name="tx" value="${escapar(datos.tx)}">
  <input type="hidden" name="paso" value="contrasena">
  <label for="correo">Correo</label>
  <input id="correo" name="correo" type="email" required maxlength="254" autocomplete="username" value="${escapar(datos.correo ?? '')}">
  <label for="contrasena">Contraseña</label>
  <input id="contrasena" name="contrasena" type="password" required maxlength="200" autocomplete="current-password">
  <button type="submit">Continuar</button>
</form>`,
  );
}

export function paginaCodigo(datos: { tx: string; cliente: string; destino: string; error?: string }) {
  return marco(
    'Código de verificación',
    `<h1>Código de verificación</h1>
${solicitante(datos.cliente, datos.destino)}
<p>Escriba el código de 6 dígitos de su app de autenticación.</p>
${alerta(datos.error)}
<form method="post" action="/authorize" autocomplete="off">
  <input type="hidden" name="tx" value="${escapar(datos.tx)}">
  <input type="hidden" name="paso" value="codigo">
  <label for="codigo">Código</label>
  <input id="codigo" name="codigo" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" autofocus>
  <button type="submit">Verificar</button>
</form>`,
  );
}

export function paginaError(titulo: string, mensaje: string) {
  return marco(titulo, `<h1>${escapar(titulo)}</h1><p>${escapar(mensaje)}</p><p class="muted">Cierre esta ventana y vuelva a conectar desde su aplicación.</p>`);
}
