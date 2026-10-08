# Hardening de seguridad BEYONIX — 2026-10-07

Este documento complementa la auditoría previa en `docs/security-audit-2026-10-07.md`.
Describe el código local preparado; no certifica una configuración de VPS,
Cloudflare ni Supabase remoto que no se pudo inspeccionar desde este entorno.
No hubo commit, push ni despliegue.

## Riesgos y estado

| Área | Resultado local | Pendiente operativo |
| --- | --- | --- |
| Rate limiting | Fragmentos Nginx por IP real, zonas separadas para auth, APIs externas y reportes | Instalar y probar en la VPS; comprobar límites de Supabase Auth/PostgREST |
| CSP | En producción el proxy emite enforcement por defecto, con nonce | Desplegar, confirmar `CSP_MODE` y observar reportes reales |
| TLS | Fragmento sólo TLS 1.2/1.3 | Sustituir la directiva antigua en la VPS y probar handshake al origen |
| Cookies Supabase | `getAll`/`setAll` persisten refresh y borrado; Secure, Lax, Path y JS se conservan | Verificar sesión y logout reales tras el despliegue |
| HSTS | `max-age=31536000` en Next producción | Confirmar respuesta y ausencia de un header distinto en Cloudflare/Nginx |
| Puerto 3000 | `npm start` vincula a `127.0.0.1` | Confirmar comando PM2 efectivo y socket en la VPS |
| Headers/métodos/CORS | Next es fuente de headers; sin ACAO comodín propio; TRACE bloqueado en fragmento Nginx | Verificar headers y métodos del host publicado |
| Body/reportes | 8 MB general, 6 MB comprobantes, 255 MB reclamos; CSP report lee máx. 8 KB y limita logs | Activar límites Nginx y comprobar uploads representativos |
| Secretos/errores | Rutas públicas críticas no devuelven errores crudos; logs de auth/checkout/webhook se acotan | Revisar logs y configuración operativa de acceso sin exponer valores |
| Dependencias | Next actualizado a 16.3.8 (patch: cierra los avisos altos publicados para 16.0.0–16.3.7, incl. SSRF en Image Optimization y cache poisoning SSG/ISR self-hosted); parches transitivos compatibles | Resolver avisos restantes por tarea específica |

La CSP permite imágenes y videos `https:` porque Admin puede configurar URLs
externas de esos recursos. Los scripts usan nonce y `strict-dynamic`; no hay
`unsafe-eval` en producción. `style-src 'unsafe-inline'` sigue siendo necesario
para estilos inline actuales. `CSP_MODE=report-only` es un rollback explícito;
si esa variable permanece así en la VPS, la política no entra en enforcement.

HSTS no incluye `includeSubDomains` ni `preload`: no se verificó HTTPS en todos
los subdominios. La cookie Supabase sigue `HttpOnly=false` por la sesión del
cliente JavaScript. La configuración de cookies no fija `Domain`.

## Dependencias residuales

Con `--omit=dev` quedan 4 (2 altos, 2 moderados, 0 críticos) y ninguno es
explotable en el uso actual: `xlsx` (alto; sólo se parsea en el navegador del
Admin con un archivo que el Admin elige, nunca en el servidor), `node-forge`
(alto; el aviso es sobre verificación de firmas PKCS#1 v1.5 y el proyecto sólo
firma el CMS de WSAA), y `mercadopago`/`uuid` (moderados; el aviso requiere
pasar `buf` a uuid v3/v5/v6, el SDK no lo hace; el fix exige el SDK 3.x). El
resto de `npm audit` corresponde al árbol de lint (`eslint-config-next`), sólo
desarrollo. No hay corrección npm
compatible publicada para `xlsx` ni `node-forge`; la migración de librería o
SDK requiere pruebas funcionales propias y no se mezcló con este hardening.

## Controles revisados sin cambios de esquema

- Las migraciones consultadas contienen RLS, revocaciones de RPC internas,
  `SECURITY DEFINER` con `search_path` fijado y verificaciones server-side para
  operaciones financieras. Las consultas de
  `docs/audits/production-security-readonly.sql` se ejecutaron contra PROD
  (sólo lectura, Management API): 174 migraciones remotas = 174 locales; las
  únicas tablas sin RLS (`catalog_barcode_registry`, `catalog_sku_registry`)
  no otorgan ningún privilegio a `anon` ni `authenticated`; las RPC
  `SECURITY DEFINER` invocables validan rol o identidad internamente.
  `handle_new_user()` (trigger) no fija `search_path`.
- Mercado Pago valida HMAC, ventana temporal y reentrega; además consulta el
  pago real y usa barreras de idempotencia en base. Andreani exige autorización
  interna para creación y dispone de claim idempotente. No se generaron pagos,
  facturas ni envíos durante esta revisión.
- La búsqueda de ACAO en APIs/proxy/config no encontró `*` ni lógica CORS
  propia. Los webhooks no necesitan CORS. Next responde 405 para métodos de
  route handlers no implementados; los cron GET que mutan requieren Bearer y
  son invocados desde systemd por loopback.

## Activación y verificación pendientes

Seguir `deploy/nginx/README.md` sobre una copia actualizada en la VPS. Allí
están los cuatro fragmentos, los lugares exactos de inclusión, `nginx -t`
antes de reload y las pruebas de TLS, puerto, cabeceras y límites. No aplicar
un fragmento sobre directivas existentes sin inspeccionar `nginx -T`, porque
puede duplicar `ssl_protocols`, `real_ip_header` o un `location`.

Tras publicar la aplicación, verificar una navegación de Home, login, cuenta,
checkout, Admin, imágenes, mapa y video con la consola y los reportes CSP.
Confirmar refresh y logout Supabase en HTTPS, así como login local por HTTP.
Inspeccionar los headers finales que reciba el navegador para descartar reglas
contradictorias introducidas por Cloudflare/Nginx. Revisar el socket de PM2 y
las políticas/rate limits efectivos de Supabase antes de aprobar producción.

**Estado de esta revisión local:** código preparado; operación de producción
**no aprobada** hasta aplicar y verificar los controles de infraestructura.

Smoke test del build local: `npm start` escuchó sólo en `127.0.0.1:3000`;
`HEAD /` devolvió CSP enforcement, HSTS anual, `nosniff`, frame/referrer/
permissions policy y no devolvió `X-Powered-By`. `POST /api/payment-methods`
y `GET /api/csp-report` devolvieron 405. Un TRACE directo al proceso Next
devolvió 500; por eso el bloqueo TRACE en Nginx es requisito operativo antes
de aprobar la ruta pública.

Una consulta `HEAD /` de sólo lectura a `https://beyonix.com.ar/` durante esta
revisión seguía mostrando `Content-Security-Policy-Report-Only`, HSTS de
`max-age=604800` y `X-Powered-By: Next.js`. Estos son los headers de la versión
publicada anterior; no se hizo despliegue para modificarlos.
