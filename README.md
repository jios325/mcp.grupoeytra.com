# mcp.grupoeytra.com

Servidor [MCP](https://modelcontextprotocol.io) de Grupo Eytra. Con él, Claude (claude.ai, Claude Desktop, Claude Code) y otros clientes MCP consultan desde la información pública del sitio hasta los datos de cada usuario del CMS, según su rol.

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
| **Equipo Eytra** (Ventas, Laboratorio, Técnico de campo, Almacén) | lo público + `mi_cuenta`, `resumen_del_dia`; `documentos` incluye los internos | API del asistente como esa persona |
| **Super Admin y Finanzas** | solo lo público: el login se rechaza | La API no deja entrar a roles con doble factor obligatorio por el asistente; el MCP aplica la misma regla |
| **Comprador de la tienda** | solo lo público: el login se rechaza | Igual que en la API |

Las herramientas apagadas en **CMS › Asistente IA** desaparecen para todos. El permiso se decide en la base (`assistant_call` + RLS); el MCP solo filtra qué herramientas anuncia según lo que responde `/me`. Cada llamada queda en `assistant_log` con la llave «MCP».

## Cómo se identifica a la persona

La API del asistente confía en el encabezado `X-Eytra-User` porque la llave está en manos de un servidor (OpenClaw) que ya verificó a la persona. Un conector MCP lo usa cualquiera, así que aquí la persona **inicia sesión**:

1. Claude llama una herramienta privada sin token → el MCP responde `401` con `WWW-Authenticate` (autenticación perezosa: lo público no pide login).
2. Claude descubre el servidor de autorización (`/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`), se registra (`/register`, RFC 7591) y abre `/authorize` con PKCE S256.
3. La persona escribe el correo y la contraseña del portal o del CMS; si tiene app de autenticación, el código de 6 dígitos. El MCP lo comprueba contra Supabase Auth, cierra esa sesión de Supabase de inmediato y pregunta a la API (`/me`) si la persona puede usar el asistente.
4. El MCP emite su propio access token (JWT de 1 hora con audiencia `…/mcp`) y un refresh token de 30 días que rota en cada uso; si alguien reusa uno viejo, se revoca toda la sesión. Cada renovación vuelve a consultar `/me`: desactivar a la persona en el CMS la deja fuera.
5. En cada llamada privada el MCP manda a la API el **id de Supabase** de la persona, nunca un dato que alguien escribió.

Protecciones adicionales (revisión de seguridad del 26 oct 2026):

- El login solo regresa a `claude.ai`, `claude.com` (`MCP_REDIRECT_HOSTS`) o a `localhost`; así nadie puede registrar un cliente llamado «Claude» que se quede con el código. Para otros clientes MCP, agregar su host a esa variable.
- Los errores antes del login muestran una página y no redirigen (sin redirecciones abiertas).
- Límites: por IP en `/authorize`, `/register` y `/token`; por cuenta solo los fallos de contraseña (10 cada 15 min) y de código (5 cada 15 min); 120 llamadas a herramientas cada 15 min por IP sin sesión, y 150 llamadas por hora a la API sin persona en total (la llave tiene 600 por hora en la API para todos).
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
| `npm run verify` | Tipos, pruebas y build |
| `npx tsx scripts/humo.ts <url>` | Prueba de humo contra un servidor en marcha. Con `MCP_HUMO_CORREO`, `MCP_HUMO_CONTRASENA` y `MCP_HUMO_TOTP` (secreto base32) también hace el login y prueba las herramientas de esa persona |

## Conectarlo

- **claude.ai / Claude Desktop**: Configuración › Conectores › Agregar conector personalizado › `https://mcp.grupoeytra.com/mcp`. Las herramientas públicas funcionan de inmediato; al usar una privada, Claude muestra «Conectar» y abre el login.
- **Claude Code**:

```bash
claude mcp add --transport http grupo-eytra https://mcp.grupoeytra.com/mcp
```

  Luego `/mcp` › grupo-eytra › Authenticate para iniciar sesión.

## Producción (Docker en el droplet)

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
- **Super Admin y Finanzas**: hoy no entran (la API los rechaza porque una llave no es un segundo factor). El MCP sí verifica su código TOTP, así que podría habilitarse con un cambio en `assistant_call` que acepte personas verificadas con aal2.
- **CIMD** (Client ID Metadata Documents): no implementado; Claude usa el registro dinámico (`/register`), que es lo que anuncia el servidor.
- SDK: `@modelcontextprotocol/server` v2 (spec 2026-07-28) con respaldo sin estado para clientes de la spec 2025.

Licencias de dependencias: MIT o Apache-2.0.
