import { leerConfig } from './config.js';
import { crearApp } from './servidor.js';

const config = leerConfig();
const { app, almacen } = crearApp(config);

const servidor = app.listen(config.puerto, config.host, () => {
  console.info(`[mcp] escuchando en http://${config.host}:${config.puerto} · recurso ${config.recurso}`);
});

function apagar() {
  servidor.close(() => {
    almacen.cerrar();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', apagar);
process.on('SIGINT', apagar);
