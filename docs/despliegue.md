# Despliegue en producción

Mismo droplet que el sitio, el CMS y el chat (137.184.91.152, alias SSH `grupoeytra`/`webprojects`, Apache con certbot). El DNS de `mcp.grupoeytra.com` ya apunta ahí (Neubox).

| Pieza | Valor |
|---|---|
| Carpeta | `/var/www/mcp.grupoeytra.com`, clon de este repo (público: no necesita credenciales) en la rama `development` |
| Contenedor | `eytra-mcp` (`docker-compose.yml`), `127.0.0.1:8330`, volumen `mcp_datos` con el SQLite |
| Vhost | `/etc/apache2/sites-available/subdominio-mcp.grupoeytra.com.conf` (copia de `deploy/apache/mcp.grupoeytra.com.conf`) + `-le-ssl` de certbot |
| CMS | `https://cms.grupoeytra.com/api/v1/assistant` (contenedor `eytra-cms-prod`) |
| Supabase | `https://api-cms.grupoeytra.com` (llave publicable: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` de `/var/www/cms.grupoeytra.com/deploy/prod.env`) |

## Primera instalación

1. **Llave del asistente**: en https://cms.grupoeytra.com › Asistente IA › Acceso a la API › Nueva llave, nombre «MCP». Se muestra una vez.
2. **Código y `.env`** (en el servidor):

```bash
git clone -b development https://github.com/jios325/mcp.grupoeytra.com.git /var/www/mcp.grupoeytra.com
cd /var/www/mcp.grupoeytra.com
cp .env.example .env && chmod 600 .env
# Editar .env:
#   MCP_PUBLIC_URL=https://mcp.grupoeytra.com
#   HOST=0.0.0.0
#   SUPABASE_URL=https://api-cms.grupoeytra.com
#   SUPABASE_PUBLISHABLE_KEY=<la del CMS>
#   EYTRA_ASSISTANT_URL=https://cms.grupoeytra.com/api/v1/assistant
#   EYTRA_ASSISTANT_KEY=<la llave «MCP»>
#   MCP_TOKEN_SECRET=$(openssl rand -hex 32)
#   CLIENT_IP_HEADER=x-forwarded-for
docker compose up -d --build
curl -s http://127.0.0.1:8330/salud
```

3. **Apache y HTTPS**:

```bash
cp deploy/apache/mcp.grupoeytra.com.conf /etc/apache2/sites-available/subdominio-mcp.grupoeytra.com.conf
a2ensite subdominio-mcp.grupoeytra.com && apache2ctl configtest && systemctl reload apache2
certbot --apache -d mcp.grupoeytra.com --redirect
```

4. **Comprobar** desde la Mac: `npx tsx scripts/humo.ts https://mcp.grupoeytra.com` (con `MCP_HUMO_CORREO`/`MCP_HUMO_CONTRASENA` de una cuenta de prueba para el flujo con sesión).

## Actualizar

```bash
ssh grupoeytra 'set -e; cd /var/www/mcp.grupoeytra.com && git pull --ff-only origin development && docker compose up -d --build && sleep 3 && curl -sf http://127.0.0.1:8330/salud'
```

## Notas

- El CMS consulta `/me` por cada inicio de sesión y renovación; la llave tiene 600 llamadas por hora en la API para todos los usos del MCP.
- Cambiar `MCP_TOKEN_SECRET` invalida al instante los access tokens; los clientes renuevan con su refresh token sin volver a iniciar sesión. Para cerrar todas las sesiones, además borrar el volumen `mcp_datos`.
- Revocar la llave «MCP» en el CMS deja fuera todo lo privado al instante; lo público del sitio y las vistas sigue funcionando salvo `documentos`.
