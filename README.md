# mcp.grupoeytra.com

Servidor [MCP](https://modelcontextprotocol.io) de Grupo Eytra. Con él, Claude (claude.ai, Claude Desktop, Claude Code), ChatGPT y otros clientes MCP consultan desde la información pública del sitio hasta los datos de cada usuario del CMS, según su rol.

```
Claude ──HTTPS──▶ mcp.grupoeytra.com/mcp ─┬─▶ grupoeytra.com (llms.txt y páginas)           público
                                          ├─▶ vistas *_public del CMS (Supabase, rol anon)   público
                                          └─▶ API del asistente del CMS ──▶ assistant_call   por persona (RLS)
           login OAuth ──▶ Supabase Auth del CMS (contraseña + app de autenticación)
```

## Qué puede consultar cada quien

| Quién | Herramientas | Fuente |
|---|---|---|
| **Cualquiera, sin sesión** | `buscar_en_sitio`, `leer_pagina`, `datos_de_contacto`, `catalogo_de_productos`, `envios_devoluciones_y_pagos`, `articulos_del_blog`, `leer_articulo`, `documentos` y `leer_documento` (solo públicos) | llms.txt y páginas de grupoeytra.com, vistas `*_public` y `shop_catalog` del CMS, `/knowledge` de la API |
| **Cliente** (Cliente admin, Cliente operador) | lo público + `mi_cuenta`, `estado_de_cuenta`, `archivos_de_factura`, `resultados_de_laboratorio`, `crear_solicitud` | API del asistente como esa persona: solo su empresa, y sus propiedades si está limitado a algunas (RLS) |
| **Equipo Eytra** (Ventas, Laboratorio, Técnico de campo, Almacén) | lo público + `mi_cuenta`, `resumen_del_dia`; `documentos` incluye los internos; con Editar en Cotizaciones (Ventas), `crear_cotizacion` (en borrador) y `estado_de_cotizacion` | API del asistente como esa persona |
| **Super Admin** | lo del equipo, cotizaciones incluidas, **solo si inició sesión con su app de autenticación** (aal2) | La API lo deja entrar porque la llave «MCP» está marcada como «verifica el doble factor» (CMS › Asistente IA › Acceso a la API, la marca solo un Super Admin) y el MCP manda `X-Eytra-AAL: aal2`. Sin la marca o sin código, se rechaza como antes |
| **Finanzas** | solo lo público: el login se rechaza | La API no deja entrar a roles con doble factor obligatorio por el asistente (salvo Super Admin, arriba) |
| **Comprador de la tienda** | solo lo público: el login se rechaza | Igual que en la API |

Las herramientas apagadas en **CMS › Asistente IA** desaparecen para todos. El permiso se decide en la base (`assistant_call` + RLS); el MCP solo filtra qué herramientas anuncia según lo que responde `/me`. Cada llamada queda en `assistant_log` con la llave «MCP».

## Vistas en la conversación (MCP Apps)

Quince de las diecisiete herramientas llevan además una vista interactiva que el cliente dibuja dentro de la conversación: tabla de facturas con botón de PDF y XML, catálogo con búsqueda, resultados de laboratorio con lo que cumple y lo que no, cotización con partidas y totales, etc. Es la extensión oficial [MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) (`io.modelcontextprotocol/ui`) con `@modelcontextprotocol/ext-apps`.

- **Cómo se enlaza**: cada herramienta de `CON_VISTA` (`src/vistas.ts`) anuncia `_meta.ui.resourceUri` con un recurso `ui://grupo-eytra/<herramienta>.html`. Quitarla de esa lista le quita la vista.
- **Un cliente sin soporte no nota nada**: ignora `_meta.ui` y recibe el mismo JSON en texto. El resultado para el modelo no cambió.
- **La vista no lleva datos**: es un solo HTML estático (`vista/`), igual para todos y legible sin sesión. Los datos llegan con el resultado de la herramienta, que sí pasa por la sesión, los permisos y la bitácora.
- **La vista no habla con el servidor ni con el CMS**: corre en un iframe sin red. Para pedir más (el PDF de una factura, otra búsqueda del catálogo, abrir un documento) le pide al cliente que llame otra herramienta de este MCP; esas llamadas cuentan en los mismos topes por persona y por visitante.
- **Sin recursos externos**: todo el JS y el CSS van incrustados (≈ 690 kB por el SDK), así que no se declara `_meta.ui.csp`. Si algún día se muestran imágenes del catálogo, hay que declarar ahí su dominio.
- **Lo que llega se escribe como texto**, nunca como HTML: son datos del CMS y del sitio.
- **Sin vista a propósito**: `leer_pagina` y `leer_articulo` son texto largo para que el modelo lo lea; la guía de diseño de Claude desaconseja vistas de contenido largo o estático.
- **Origen para Claude**: el recurso declara `_meta.ui.domain` con los primeros 32 caracteres hexadecimales del SHA-256 de `MCP_PUBLIC_URL` + `/mcp`, en `claudemcpcontent.com` ([docs de Claude](https://claude.com/docs/connectors/building/mcp-apps/getting-started)). Solo con URL `https` y solo si el cliente no se identifica como otro (el formato es de cada cliente). **Si cambia la URL pública del conector, cambia el origen**: hay que hashear la URL exacta, sin diagonal final de más.
- **Corta dentro del chat**: Claude recorta las tarjetas altas y no hay scroll propio, así que las listas se cortan y «Ver todo» pide pantalla completa (`ui/request-display-mode`); si el cliente no la ofrece, se expanden ahí mismo.
- **Enlaces que caducan**: los de PDF, XML y documentos duran 60 segundos y Claude pide confirmar antes de abrir un enlace externo, así que la vista pide el enlace en el mismo clic que lo abre, nunca usa uno que ya venía en el resultado.

`npm run vista` empaqueta `vista/` en `src/vista.generada.ts` (no se versiona; `dev`, `typecheck`, `test` y `build` lo corren solos). `npm run vista:previa` abre en `http://localhost:8332` cada pantalla con datos de ejemplo, usando el `AppBridge` oficial como cliente: sirve para revisar cambios sin conectar Claude ni ChatGPT.

## Cómo se identifica a la persona

La API del asistente confía en el encabezado `X-Eytra-User` porque la llave está en manos de un servidor (OpenClaw) que ya verificó a la persona. Un conector MCP lo usa cualquiera, así que aquí la persona **inicia sesión**:

1. Claude llama una herramienta privada sin token → el MCP responde `401` con `WWW-Authenticate` (autenticación perezosa: lo público no pide login).
2. Claude descubre el servidor de autorización (`/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`), se registra (`/register`, RFC 7591) y abre `/authorize` con PKCE S256.
3. La persona escribe el correo y la contraseña del portal o del CMS; si tiene app de autenticación, el código de 6 dígitos. El MCP lo comprueba contra Supabase Auth, cierra esa sesión de Supabase de inmediato y pregunta a la API (`/me`) si la persona puede usar el asistente.
4. El MCP emite su propio access token (JWT de 1 hora con audiencia `…/mcp`) y un refresh token de 30 días que rota en cada uso; si alguien reusa uno viejo, se revoca toda la sesión (los ya usados se guardan hasta vencer para poder detectarlo, y gastar uno y emitir el siguiente es un solo paso). Cada renovación vuelve a consultar `/me`: desactivar a la persona en el CMS la deja fuera.
5. En cada llamada privada el MCP manda a la API el **id de Supabase** de la persona, nunca un dato que alguien escribió, y `X-Eytra-AAL: aal2` si pasó su app de autenticación al iniciar sesión. Ese nivel queda en el access token y en la familia del refresh token: renovar no lo sube ni lo pide de nuevo.

Protecciones adicionales (revisión de seguridad del 26 oct 2026):

- El login solo regresa a `claude.ai`, `claude.com`, `chatgpt.com` (`MCP_REDIRECT_HOSTS`) o a `localhost`; así nadie puede registrar un cliente llamado «Claude» que se quede con el código. Para otros clientes MCP, agregar su host a esa variable.
- Los errores antes del login muestran una página y no redirigen (sin redirecciones abiertas).
- Límites: por IP en `/authorize`, `/register` y `/token`; por cuenta solo los fallos, que se apartan antes de consultar a Supabase para que los intentos simultáneos no pasen juntos: contraseña, 10 cada 15 min por cuenta y dirección y 30 por cuenta entre todas las direcciones (así un extraño no deja fuera a la persona con diez intentos); código, 5 cada 15 min por cuenta. Sin sesión: 120 llamadas a herramientas cada 15 min por IP, 30 por hora por IP a `documentos` y `leer_documento`, y 150 por hora a la API sin persona en total. Con sesión: 120 llamadas a herramientas por hora por persona (la llave tiene 600 por hora en la API para todos, y la API la cobra antes que el tope por persona).
- `/mcp` responde 415 a un POST cuyo cuerpo Express no analizó como JSON: lo que revisa la puerta es siempre lo que se ejecuta. El servidor declara que no avisa de cambios en la lista de herramientas, así que no quedan escuchas (`subscriptions/listen`) abiertas.
- `leer_pagina` corta la descarga a los 2 MB aunque la página no declare su tamaño y hace como máximo 8 descargas a la vez.
- Un 429 o una caída de la API nunca cierra sesiones: solo un 403/404 de `/me` (persona desactivada o sin acceso).
- `leer_pagina` solo pide el esquema, host y puerto del sitio (sin saltar a otros puertos del servidor).

No se guardan contraseñas ni sesiones de Supabase. La base SQLite (`data/mcp.sqlite`) solo tiene clientes registrados y hashes de códigos y refresh tokens.

## Arrancar en local

Requisitos: Node ≥ 22.13, el Supabase de `../supabase` (`docker compose up -d`) y el CMS en `:3300` (`npm run dev` en `../cms.grupoeytra.com`).

```bash
cp .env.example .env   # SUPABASE_* del .env.local del CMS, una llave del asistente y un MCP_TOKEN_SECRET
npm install
npm run dev            # http://localhost:8330, el conector es http://localhost:8330/mcp
```

La llave sale de **CMS › Asistente IA › Acceso a la API › Nueva llave** (nómbrela «MCP»).

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor con recarga en `:8330` |
| `npm test` | Pruebas: unidades y el flujo OAuth + MCP completo con el CMS falso |
| `npm run vista` | Empaqueta la vista de MCP Apps (`vista/` → `src/vista.generada.ts`) |
| `npm run vista:previa` | Previsualiza las vistas con datos de ejemplo en `:8332` |
| `npm run verify` | Tipos, pruebas y build |
| `npx tsx scripts/humo.ts <url>` | Prueba de humo contra un servidor en marcha. Con `MCP_HUMO_CORREO`, `MCP_HUMO_CONTRASENA` y `MCP_HUMO_TOTP` (secreto base32) también hace el login y prueba las herramientas de esa persona |

## Conectarlo

- **claude.ai / Claude Desktop**: Configuración › Conectores › Agregar conector personalizado › `https://mcp.grupoeytra.com/mcp`. Las herramientas públicas funcionan de inmediato; al usar una privada, Claude muestra «Conectar» y abre el login.
- **Claude Code**:

```bash
claude mcp add --transport http grupo-eytra https://mcp.grupoeytra.com/mcp
```

  Luego `/mcp` › grupo-eytra › Authenticate para iniciar sesión.

- **ChatGPT** (web): en https://chatgpt.com/plugins, **+** › **Add custom MCP server**. Nombre «Grupo Eytra», Server URL `https://mcp.grupoeytra.com/mcp` (exacta: es el `resource` que valida el login) y autenticación **OAuth**, sin ID ni secreto de cliente (se registra solo en `/register`). Acepte el aviso, **Create as a plugin**, inicie sesión e instálelo; en el chat se elige con **@**. Si no aparece la opción, puede hacer falta el modo de desarrollador o que el administrador del espacio lo permita.
  - ChatGPT vuelve a `https://chatgpt.com/connector_platform_oauth_redirect` (el servidor anuncia RFC 9207 y manda `iss`) o a `https://chatgpt.com/connector/oauth/<id>`; ambos entran por `chatgpt.com` en `MCP_REDIRECT_HOSTS`.
  - Con **OAuth** pide iniciar sesión desde el principio, también para lo público. Para **OAuth or no authentication** ChatGPT espera `securitySchemes` en cada herramienta y `_meta["mcp/www_authenticate"]` en el error, no el `401` que usa Claude; no está implementado.

## Producción (Docker en el droplet)

Paso a paso de la primera instalación y de las actualizaciones en [docs/despliegue.md](docs/despliegue.md).

```bash
cp .env.example .env    # MCP_PUBLIC_URL=https://mcp.grupoeytra.com, CLIENT_IP_HEADER=x-forwarded-for, URLs de producción y una llave «MCP» de producción
docker compose up -d --build
```

- Publica `127.0.0.1:8330`; Apache hace HTTPS para `mcp.grupoeytra.com` y reenvía todo a ese puerto (`ProxyPass / http://127.0.0.1:8330/`, `ProxyPreserveHost On`). No hay SSE de larga duración: las respuestas son JSON por petición.
- El servidor de autorización debe ser alcanzable desde las IP de Anthropic (160.79.104.0/21) para claude.ai.
- `data/` vive en el volumen `mcp_datos`. Cambiar `MCP_TOKEN_SECRET` invalida los access tokens; borrar el volumen obliga a todos a reconectar.
- Contenedor de solo lectura, sin privilegios nuevos, usuario `node`, 256 MB.

## Decisiones y pendientes

- **Por qué un servidor de autorización propio y no el OAuth Server de Supabase**: el de Supabase está en beta, no está documentado para self-hosted, exige una pantalla de consentimiento en el CMS y emite tokens con `aud: authenticated` en lugar de la URL del MCP. Si se adopta más adelante, solo cambia `src/auth/`.
- **Canal en la bitácora**: la API no tiene canal `mcp`; se usa `other` y la llave «MCP» lo distingue en `assistant_log`. Un canal propio requiere una migración en el CMS (`assistant_channel`).
- **Sesiones y cambios de credencial** (pendiente, auditoría del 14 nov 2026): una sesión del MCP ya emitida no se entera de un cambio de contraseña ni del alta o la baja del doble factor en Supabase; solo la corta un 403/404 de `/me`, y cada renovación le da otros 30 días. Cerrarlo requiere que `/me` devuelva una marca del último cambio de credenciales (CMS) y que el MCP revoque las familias anteriores a esa marca, además de una vida máxima por familia.
- **Cupo de la llave en la API** (pendiente en el CMS): `assistant_call` descuenta el cupo de la llave antes que el de la persona, así que las llamadas que rechaza por persona también lo gastan. El MCP lo compensa con su tope por persona; lo correcto es invertir el orden en el CMS.
- **Vistas (MCP Apps)** (pendiente): probadas en local contra el `AppBridge` del SDK, no todavía en Claude ni en ChatGPT; cada cliente aplica su propia política al iframe, y Claude solo las dibuja con el conector remoto en `https` (no con `localhost`). Ajustadas el 14 nov 2026 a la documentación de Claude para quien construye MCP Apps (`claude.com/docs/connectors/building/mcp-apps`). Las vistas de `crear_solicitud` y `crear_cotizacion` muestran el resultado, no un formulario previo: la confirmación sigue siendo del modelo con el usuario.
- **CIMD** (Client ID Metadata Documents): no implementado; Claude y ChatGPT usan el registro dinámico (`/register`), que es lo que anuncia el servidor.
- SDK: `@modelcontextprotocol/server` v2 (spec 2026-07-28) con respaldo sin estado para clientes de la spec 2025.

Licencias de dependencias: MIT o Apache-2.0.
