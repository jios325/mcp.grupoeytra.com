// Empaqueta la vista (vista/app.ts + vista/estilos.css + @modelcontextprotocol/ext-apps) en un solo HTML sin
// recursos externos y lo deja como módulo en src/vista.generada.ts, que el servidor sirve como recurso ui://.
// Un solo archivo porque el iframe del cliente no tiene red: todo el JS y el CSS van incrustados.
// Lo corren los scripts de package.json (vista, dev, typecheck, test, build); el resultado no se versiona.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build, transform } from 'esbuild';

const raiz = new URL('../', import.meta.url);
const ruta = (relativa) => fileURLToPath(new URL(relativa, raiz));

/** El HTML completo de la vista, con el marcador __VISTA__ sin sustituir. */
export async function construirHtml() {
  const paquete = await build({
    entryPoints: [ruta('vista/app.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
  });
  const estilos = await transform(await readFile(ruta('vista/estilos.css'), 'utf8'), { loader: 'css', minify: true });

  // Dentro de <script> y <style>, estas secuencias cerrarían la etiqueta o abrirían un comentario HTML.
  const js = paquete.outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  const css = estilos.code.replace(/<\/(style)/gi, '<\\/$1');

  // data-vista: el servidor sustituye __VISTA__ por el nombre de la herramienta al servir cada recurso.
  const html = [
    '<!doctype html>',
    '<html lang="es-MX" data-vista="__VISTA__">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Grupo Eytra</title>',
    `<style>${css}</style></head>`,
    '<body><main id="raiz"><p class="tenue">Cargando…</p></main>',
    `<script>${js}</script>`,
    '</body></html>',
  ].join('\n');
  return html;
}

// Solo al correrlo directo (npm run vista); scripts/previa-vista.mjs importa la función.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const html = await construirHtml();
  await writeFile(
    ruta('src/vista.generada.ts'),
    `// Generado por scripts/construir-vista.mjs a partir de vista/. No editar: cambie vista/ y corra «npm run vista».\nexport const HTML_VISTA: string = ${JSON.stringify(html)};\n`,
  );
  console.log(`[vista] src/vista.generada.ts (${Math.round(html.length / 1024)} kB)`);
}
