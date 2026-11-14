# CLAUDE.md

Servidor MCP de Grupo Eytra (Node + TypeScript, SDK `@modelcontextprotocol/server` v2). Qué expone, roles, flujo OAuth y despliegue en `README.md`.

## Repositorios relacionados

| Ruta | Relación |
|------|----------|
| `../cms.grupoeytra.com` | API del asistente (`docs/asistente-api.md`, `src/lib/assistant/api.ts`, función `assistant_call`): fuente de todos los datos por persona. Vistas `*_public` en `docs/sitio-cms.md` |
| `../grupoeytra.com` | Sitio público: `llms.txt` (generado en `src/pages/llms.txt.ts`) y páginas que leen las herramientas públicas |
| `../supabase` | Supabase self-hosted del CMS: Auth (login del MCP) y base |
| `../chat.grupoeytra.com` | Asistente público del sitio; distinto de este |

## Comandos

```bash
npm run dev       # :8330 (CMS en :3300 y Supabase en :8300 arriba)
npm run verify    # tipos + pruebas + build; una tarea termina con esto en verde
npm run vista:previa   # :8332, las vistas de MCP Apps con datos de ejemplo (vista/)
npx tsx scripts/humo.ts http://localhost:8330   # prueba de humo contra el servidor en marcha
```

## Reglas

- **Nunca** acceder a la base del CMS directo ni con `service_role`: lo privado va por la API del asistente, que aplica RLS y deja bitácora. Lo público, solo vistas `*_public` con la llave publicable.
- `X-Eytra-User` lleva siempre el id de Supabase que salió del login verificado, nunca un correo o teléfono que alguien escribió.
- Una herramienta nueva que toque datos de una persona: primero en `assistant_call` (CMS), luego aquí en `PROTEGIDAS` de `src/herramientas.ts` con la herramienta de la API que la respalda.
- Vistas (MCP Apps, `vista/` y `src/vistas.ts`): la vista nunca llama al CMS ni a la red, solo pide herramientas de este MCP al cliente; lo que recibe se escribe como texto, nunca `innerHTML`. Una herramienta nueva con vista: agregarla a `CON_VISTA`, a `VISTAS` en `vista/app.ts` y a los ejemplos de `scripts/previa-vista.mjs`.
- `leer_pagina` solo lee el dominio de `EYTRA_SITE_URL` (no es un proxy).
- Textos para el usuario en español de México, de usted; identificadores en español como el resto del código.
- `.env` y `data/` no se versionan ni se leen en voz alta.
- Licencias: solo MIT, Apache-2.0, BSD o similar.
- Commits en español con `feat:`/`fix:`/`docs:`/`chore:`, sin pie de coautoría y sin push sin preguntar.
