# Hardening Nginx de BEYONIX

Estos archivos son fragmentos para la VPS. No reemplazan el virtual host actual,
sus certificados ni la redirección HTTP → HTTPS. Antes de aplicarlos, inspeccionar
`sudo nginx -T` y evitar directivas duplicadas en `http {}` o en el `server` HTTPS.

## Instalación controlada

Desde un checkout actualizado en la VPS:

```bash
sudo nginx -T > /tmp/beyonix-nginx-before.txt 2>&1
# Sólo si la VPS todavía no tiene un conf.d con real_ip_header (la de producción
# ya lo tiene en /etc/nginx/conf.d/cloudflare-real-ip.conf; duplicarlo rompe nginx -t):
# sudo install -m 0644 deploy/nginx/cloudflare-real-ip.conf /etc/nginx/conf.d/cloudflare-real-ip.conf
sudo install -m 0644 deploy/nginx/security-http.conf /etc/nginx/conf.d/beyonix-security-http.conf
sudo install -m 0644 deploy/nginx/security-server.conf /etc/nginx/snippets/beyonix-security-server.conf
sudo install -m 0644 deploy/nginx/upload-locations.conf /etc/nginx/snippets/beyonix-upload-locations.conf
```

`/etc/nginx/conf.d/*.conf` debe estar incluido dentro de `http {}`. En el `server`
HTTPS existente de `beyonix.com.ar`, agregar una sola vez:

```nginx
include /etc/nginx/snippets/beyonix-security-server.conf;
include /etc/nginx/snippets/beyonix-upload-locations.conf;
```

En `/etc/nginx/nginx.conf`, reemplazar la línea de Ubuntu
`ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;` por `ssl_protocols TLSv1.2 TLSv1.3;`
(no agregar una segunda: es una directiva única por contexto) y no dejar ningún
`ssl_protocols` a nivel `server` que vuelva a habilitar versiones antiguas. Se
fija en `http {}` porque la selección TLS puede ocurrir antes de conocer el
virtual host por SNI. Conservar un único
`real_ip_header CF-Connecting-IP` y sólo los `set_real_ip_from` oficiales de
Cloudflare; el fragmento versionado incluye IPv4 e IPv6. Revisar periódicamente
[la lista oficial](https://www.cloudflare.com/ips/).

Los `location` de uploads incluyen `proxy_pass` y cabeceras de proxy porque
reemplazan la selección del `location /` actual. Comparar cualquier opción
adicional de ese bloque antes de incluirlos. El límite general de 8 MB cubre
imágenes y comprobantes; el reclamo admite hasta seis videos de 40 MB más el
multipart (255 MB). Los uploads directos a Supabase Storage no pasan por Nginx.

En el `location /` existente y en cualquier otro bloque que haga `proxy_pass`,
sobrescribir `X-Real-IP` con la IP ya validada por Nginx:

```nginx
proxy_set_header X-Real-IP $remote_addr;
```

Las rutas de recuperación y reenvío de email usan sólo esa cabecera para su
límite por IP. No reenviar un `X-Real-IP` proporcionado por el cliente.

No duplicar HSTS, CSP, `X-Frame-Options`, `Permissions-Policy` ni los otros
headers de aplicación en Nginx: su fuente es Next.js. No cachear respuestas
con `Set-Cookie`; conservar la configuración actual de proxy sin caché para
`/admin`, `/cuenta` y APIs autenticadas.

## Verificación antes de activar

```bash
sudo nginx -t
sudo nginx -T 2>&1 | grep -E 'ssl_protocols|real_ip_header|set_real_ip_from|limit_req|client_max_body_size'
sudo systemctl reload nginx
ss -ltnp | grep ':3000'
curl -Ik https://beyonix.com.ar/
openssl s_client -connect beyonix.com.ar:443 -servername beyonix.com.ar -tls1 </dev/null
openssl s_client -connect beyonix.com.ar:443 -servername beyonix.com.ar -tls1_1 </dev/null
openssl s_client -connect beyonix.com.ar:443 -servername beyonix.com.ar -tls1_2 </dev/null
openssl s_client -connect beyonix.com.ar:443 -servername beyonix.com.ar -tls1_3 </dev/null
```

`nginx -t` debe aprobar antes del reload. El puerto 3000 debe mostrar sólo
`127.0.0.1:3000`; TLS 1.0/1.1 deben fallar y 1.2/1.3 negociar. Si Cloudflare
termina TLS en el borde, probar además la IP de origen con `-connect IP:443`
y `-servername beyonix.com.ar`, sin publicar la IP. Comprobar que Cloudflare
usa Full (strict) y que el origen no acepta tráfico público directo salvo
desde sus rangos. Los límites deben producir 429 sólo bajo ráfagas de prueba
controladas, no en navegación normal. `nginx -t` y el reload no se ejecutan
desde el entorno Windows de desarrollo.
