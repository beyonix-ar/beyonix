# Auditoría de seguridad BEYONIX — 2026-10-07

## Inventario de rutas API

Clasificación por acceso previsto en el handler. `AUTH` requiere sesión; `AUTH/guest token` admite también posesión de un token firmado para el pedido. `ADMIN` agrupa usuarios internos con rol admitido por cada endpoint. GET público y mutación autenticada se marca `PUBLIC/AUTH`.

| Ruta | Métodos | Clase |
|---|---|---|
| `/api/account/delete` | DELETE | AUTH |
| `/api/account/store-benefits` | GET | AUTH |
| `/api/admin/arca/auto-invoicing` | GET, POST | ADMIN |
| `/api/admin/arca/diagnostics` | POST | ADMIN |
| `/api/admin/arca/status` | GET | ADMIN |
| `/api/admin/banners` | GET, POST, PATCH, DELETE | ADMIN |
| `/api/admin/barcodes` | POST | ADMIN |
| `/api/admin/clientes/[id]` | PATCH | ADMIN |
| `/api/admin/clientes/[id]/saldo` | POST | ADMIN |
| `/api/admin/clientes/bloqueos` | GET, POST, DELETE | ADMIN |
| `/api/admin/clientes/saldos` | GET, PATCH | ADMIN |
| `/api/admin/conditioned-stock/[id]` | PATCH, DELETE | ADMIN |
| `/api/admin/costs/article-by-code` | GET | ADMIN |
| `/api/admin/costs/articles` | GET | ADMIN |
| `/api/admin/costs/new-article` | POST | ADMIN |
| `/api/admin/costs` | GET, POST, PATCH, DELETE | ADMIN |
| `/api/admin/credit-notes/[noteId]/reconcile` | POST | ADMIN |
| `/api/admin/customer-credit` | GET, POST | ADMIN |
| `/api/admin/dashboard` | GET | ADMIN |
| `/api/admin/destructive-operations` | GET, POST | ADMIN |
| `/api/admin/dispatch/batches/[id]/barcode` | GET | ADMIN |
| `/api/admin/dispatch/batches/[id]` | GET, POST | ADMIN |
| `/api/admin/dispatch/batches` | POST | ADMIN |
| `/api/admin/dispatch/orders/[id]` | GET, POST | ADMIN |
| `/api/admin/dispatch` | GET | ADMIN |
| `/api/admin/facturacion/export` | POST | ADMIN |
| `/api/admin/facturacion/history` | GET | ADMIN |
| `/api/admin/facturacion` | GET | ADMIN |
| `/api/admin/financiacion/medios-de-pago/[id]/imagen` | POST, DELETE | ADMIN |
| `/api/admin/financiacion/medios-de-pago/[id]` | PATCH, DELETE | ADMIN |
| `/api/admin/financiacion/medios-de-pago` | GET, POST | ADMIN |
| `/api/admin/financiacion/medios-de-pago/sync` | POST | ADMIN |
| `/api/admin/financiacion/referencia-mercadopago` | POST | ADMIN |
| `/api/admin/integrations/andreani/test` |  | ADMIN |
| `/api/admin/inventory/diagnostics` | GET, POST | ADMIN |
| `/api/admin/inventory/notification-diagnostics` | GET | ADMIN |
| `/api/admin/mercadolibre-sales/[id]/return-review` | POST | ADMIN |
| `/api/admin/mercadolibre-sales/import` | POST | ADMIN |
| `/api/admin/mercadolibre-sales` | GET, PATCH, DELETE | ADMIN |
| `/api/admin/notifications` | GET, POST, PATCH, DELETE | ADMIN |
| `/api/admin/order-claims/[claimId]/affected-items` | PATCH | ADMIN |
| `/api/admin/order-claims/[claimId]/andreani-branches` | GET | ADMIN |
| `/api/admin/order-claims/[claimId]/andreani-shipment` | POST, GET | ADMIN |
| `/api/admin/order-claims/[claimId]` | GET, PATCH | ADMIN |
| `/api/admin/order-event-views` | GET, POST | ADMIN |
| `/api/admin/orders/[id]/credit-note` | POST | ADMIN |
| `/api/admin/orders/[id]/credit-note/settlement` | POST | ADMIN |
| `/api/admin/orders/[id]/financial-resolution` | GET, POST | ADMIN |
| `/api/admin/orders/[id]/invoice/pdf` | GET | ADMIN |
| `/api/admin/orders/[id]/invoice` | POST | ADMIN |
| `/api/admin/payment-proofs/[orderId]` | GET | ADMIN |
| `/api/admin/pedidos/[id]/andreani-reconciliation` | POST | ADMIN |
| `/api/admin/pedidos/[id]/cancel` | POST | ADMIN |
| `/api/admin/pedidos/[id]/claims` | GET | ADMIN |
| `/api/admin/pedidos/[id]/mercadopago-refund` | POST, GET | ADMIN |
| `/api/admin/pedidos/[id]/payment-status` | PATCH | ADMIN |
| `/api/admin/pedidos/[id]/refund` | GET, POST | ADMIN |
| `/api/admin/pedidos/[id]/replacements` | GET, POST | ADMIN |
| `/api/admin/pedidos/[id]/return-inventory/[itemId]` | PATCH | ADMIN |
| `/api/admin/pedidos/[id]/return-request` | PATCH | ADMIN |
| `/api/admin/pedidos/[id]/status` | PATCH | ADMIN |
| `/api/admin/pedidos/[id]/warranty/[itemId]` | PATCH | ADMIN |
| `/api/admin/pedidos` | GET | ADMIN |
| `/api/admin/product-bulk-actions` | POST | ADMIN |
| `/api/admin/product-bulk-events` | GET, POST, PATCH, DELETE | ADMIN |
| `/api/admin/products/[id]/catalog` | PATCH | ADMIN |
| `/api/admin/products/[id]/merge` | POST | ADMIN |
| `/api/admin/products/[id]/pricing` | GET | ADMIN |
| `/api/admin/products/[id]` | PATCH, DELETE | ADMIN |
| `/api/admin/products/[id]/stock-reservations` | GET | ADMIN |
| `/api/admin/products/[id]/variant-allocations` | GET, PUT | ADMIN |
| `/api/admin/products/[id]/variants/[variantId]/barcode` | POST | ADMIN |
| `/api/admin/products/[id]/variants/[variantId]` | PATCH, DELETE | ADMIN |
| `/api/admin/products/[id]/variants` | GET, POST, PUT | ADMIN |
| `/api/admin/product-variants` | GET | ADMIN |
| `/api/admin/reviews` | GET, PATCH | ADMIN |
| `/api/admin/sales-ledger/[id]/reverse` | POST | ADMIN |
| `/api/admin/sales-ledger` | GET, POST, PATCH, DELETE | ADMIN |
| `/api/admin/settings` | GET, PATCH | ADMIN |
| `/api/admin/system-health` | GET | ADMIN |
| `/api/admin/usuarios` | GET, PATCH | ADMIN |
| `/api/andreani/cotizar` | POST | PUBLIC |
| `/api/andreani/crear-envio` | POST | ADMIN |
| `/api/andreani/destinos` | GET | PUBLIC |
| `/api/andreani/etiqueta` | POST | ADMIN |
| `/api/andreani/health` | GET | INTERNAL |
| `/api/andreani/tracking` | POST | ADMIN |
| `/api/auth/confirmation-status` | POST | PUBLIC |
| `/api/auth/confirm-email` | POST | PUBLIC |
| `/api/auth/forgot-password` | POST | PUBLIC |
| `/api/auth/login` | POST | PUBLIC |
| `/api/auth/profile` | GET, PATCH | AUTH |
| `/api/auth/resend-confirmation` | POST | PUBLIC |
| `/api/cron/andreani-sync-tracking` | GET | CRON |
| `/api/cron/arca-invoices` | GET | CRON |
| `/api/cron/cleanup-claim-uploads` | GET | CRON |
| `/api/cron/expire-mercadopago-orders` | GET | CRON |
| `/api/cron/expire-transfer-orders` | GET | CRON |
| `/api/cron/reconcile-mercadopago-refunds` | GET | CRON |
| `/api/cron/run-commercial-events` | GET | CRON |
| `/api/cron/sync-mercadopago-installments` | GET | CRON |
| `/api/cron/verify-transfer-orders` | GET | CRON |
| `/api/csp-report` | POST, GET | PUBLIC |
| `/api/customer-credit/balance` | GET | AUTH |
| `/api/customer-credit/create-order` | POST | AUTH |
| `/api/customer-credit/mercadopago/abandon` | POST | AUTH |
| `/api/customer-credit/mercadopago/preference` | POST | PUBLIC (410) |
| `/api/customer-credit/mercadopago/reconcile` | POST | AUTH |
| `/api/customer-credit/movements` | GET | AUTH |
| `/api/customer-credit/topups` | GET, POST | AUTH |
| `/api/mercadopago/create-preference` | POST | PUBLIC |
| `/api/mercadopago/installments` | GET | PUBLIC |
| `/api/mercadopago/webhook` | POST, GET | WEBHOOK |
| `/api/orders/[id]/cancel` | POST | AUTH |
| `/api/orders/[id]/claims/[claimId]/return-label` | GET | AUTH |
| `/api/orders/[id]/claims/read` | POST | AUTH |
| `/api/orders/[id]/claims/replacement-options` | GET | AUTH |
| `/api/orders/[id]/claims` | GET, POST, PATCH | AUTH |
| `/api/orders/[id]/invoice` | GET | AUTH |
| `/api/orders/[id]/refund-proof` | GET | AUTH |
| `/api/orders/[id]/return-request` | POST | AUTH |
| `/api/orders/[id]` | GET | AUTH |
| `/api/orders` | GET | AUTH |
| `/api/payment-methods` | GET | PUBLIC |
| `/api/payment-proofs/[orderId]` | GET | AUTH/guest token |
| `/api/payment-proofs` | POST | AUTH/guest token |
| `/api/reviews/[id]` | DELETE | AUTH |
| `/api/reviews` | GET, POST | PUBLIC/AUTH |
| `/api/store/banners` | GET | PUBLIC |
| `/api/store/settings` | GET | PUBLIC |
| `/api/transferencia/[orderId]/titular` | POST | AUTH/guest token |
| `/api/transferencia/[orderId]/verificar` | POST | AUTH/guest token |
| `/api/transferencia/create-order` | POST | PUBLIC |

## Otras superficies

| Superficie | Clase | Alcance |
|---|---|---|
| Páginas `/`, `/productos`, `/categorias`, `/checkout`, legales, contacto, login y recuperación | PUBLICA | `app/**/page.tsx`; checkout admite guest. |
| Páginas `/cuenta/**` | AUTH | El proxy comprueba sesión; las APIs comprueban propiedad por separado. |
| Páginas `/admin/**` | ADMIN | El proxy comprueba rol y sección; las APIs no dependen del proxy. |
| RPC de compras, precios, stock, despachos, reclamos, crédito, facturación y reembolsos | INTERNAL | Migraciones en `supabase/migrations/`; se inspeccionaron RPC críticas, no todo el catálogo remoto. |
| Buckets `imagenes-productos`, `site-banners`, `payment-method-logos` | PUBLICA lectura; escritura administrativa | Los dos primeros reciben uploads desde navegador; el tercero sólo desde servidor. |
| Buckets `payment-proofs`, `order-claim-evidence` | AUTH y ADMIN; privados | Lectura con URL firmada de corta duración; uploads por handlers autorizados. |
| Mercado Pago, Andreani, ARCA, Supabase y Nominatim | INTERNAL / WEBHOOK | Credenciales server-side; algunas consultas de envío/cuotas son públicas. |
| Nueve `.service` y nueve `.timer` en `deploy/systemd/` | CRON | Plantillas con loopback, `flock` y configuración privada de curl. |
| Secretos de Supabase, Mercado Pago, Andreani, ARCA, cron y firma guest | INTERNAL | Sólo nombres; ningún valor en este informe. |

## Hallazgos

### P0 y P1

No se confirmó una vulnerabilidad P0 o P1 en el alcance probado. Esto no certifica la configuración efectiva de Supabase, Nginx, PM2, systemd ni la VPS.

### P2 corregido: tipo falsificado en comprobante de transferencia

Antes del cambio, `getPaymentProofValidationError` aceptaba un `.pdf` con MIME `application/pdf` cuyo contenido real era HTML con `<script>`. El POST de `/api/payment-proofs` lo enviaba al bucket privado sin inspeccionar bytes. Reproducción local: la función devolvió una cadena vacía. Impacto confirmado: almacenamiento de contenido arbitrario entregable por URL firmada. No se demostró ejecución de script en el navegador, por lo que se clasifica como medio.

La corrección vincula MIME y extensión, rechaza archivos vacíos, comprueba firma binaria JPG/PNG/PDF y parsea PDFs para rechazar acciones activas. Se suben los mismos bytes validados. El criterio PDF que ya protegía evidencias de reclamos se extrajo a un helper común.

### P2 pendientes: abuso de APIs externas

- `GET /api/mercadopago/installments` admite hasta 48 montos distintos por llamada pública y puede consultar Mercado Pago para cada uno. Tiene caché de respuesta de 30 segundos, pero no límite por cliente en la aplicación. Montos distintos pueden generar carga.
- `POST /api/andreani/cotizar` y `GET /api/andreani/destinos` son públicos; hay validación, timeout y caché territorial, pero no se confirmó límite de frecuencia por IP/cliente en aplicación o Nginx.
- `POST /api/auth/login` usa respuesta genérica y piso de 500 ms, pero carece de contador local de intentos. Supabase Auth puede limitar intentos; no se verificó su configuración efectiva.

La mitigación compatible con VPS es medir tráfico y aplicar límites por ruta en Nginx o en un almacén compartido. No se fijaron umbrales sin conocer tráfico legítimo y límites de proveedores.

### P3 y límites de comprobación

- La CSP tiene nonce; `CSP_MODE` sólo fuerza enforcement con valor `enforce`. No se verificó ese valor en producción. Los headers estáticos incluyen `nosniff`, `SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy` y HSTS de siete días en producción.
- La inspección de PDF rechaza acciones activas conocidas, pero no equivale a un análisis antimalware. Los buckets públicos de imágenes y banners requieren comprobar políticas efectivas y bytes reales con una cuenta de ensayo.
- Las migraciones y pruebas embebidas no sustituyen una consulta remota a `pg_policy`, ACL y `storage.buckets` de todas las tablas/funciones/buckets sensibles.
- Las nueve plantillas systemd usan loopback, `flock` y `--config` para mantener el secreto fuera de argv. No se leyeron unidades instaladas, permisos ni el archivo privado de curl en la VPS.
- `npm audit` en línea no pudo consultar el registro desde este entorno. `npm audit --offline` informó 0 vulnerabilidades desde caché local; no es una revisión vigente de advisories.

## Controles revisados

- **Auth/Admin/IDOR:** `requireInternalUser` valida claims y vuelve a leer el rol desde `profiles`; `requireAdmin` limita a admin/super_admin. Los handlers de pedidos, reclamos, facturas y comprobantes inspeccionados vinculan el ID al usuario o exigen token guest firmado. Las suites existentes prueban rechazo de usuarios comunes y de IDs ajenos. No se ejecutó una prueba dinámica contra todas las rutas de producción.
- **RLS/RPC:** las migraciones recientes de despacho, barcodes, snapshots fiscales, logos y resolución financiera habilitan RLS, revocan acceso directo sensible, fijan `search_path` en funciones `SECURITY DEFINER` y usan locks/unicidad para doble cierre, doble escaneo y colisión de códigos. La inspección estática no confirma que cada migración esté aplicada en el remoto.
- **CSRF:** las APIs admin exigen Bearer y no se apoyan en la cookie del proxy. El cliente usa sesión Supabase y token guest donde corresponde. No se reprodujo bypass CSRF. Faltó inspeccionar atributos `Set-Cookie` y reglas de origen efectivas detrás de Nginx.
- **XSS/SSRF/inyección:** la búsqueda de código de aplicación no halló `dangerouslySetInnerHTML`. El logo SVG se valida en servidor contra scripts, eventos y referencias externas. Las llamadas externas inspeccionadas usan hosts fijos; no se detectó fetch servidor hacia URL arbitraria recibida del usuario ni shell con argumentos de request.
- **Pagos:** el webhook MP verifica HMAC, edad del mensaje y replay; consulta el pago real por API y comprueba referencia, estado y total antes de confirmar. Reembolsos y crédito tienen barreras de RPC e idempotencia con pruebas de repetición/concurrencia. No se ejecutaron pagos reales.
- **Andreani:** creación, tracking y etiquetas requieren roles internos; ambiente y autorización PROD están separados. La creación es idempotente. La compatibilidad real de credenciales, contrato y sucursal PROD requiere prueba manual controlada.
- **ARCA:** handlers admin y cron están autenticados; snapshots y RPC fiscales se protegen en migraciones. No se inspeccionó certificado/clave real ni se contactó ARCA, por lo que no se certifican CAE y numeración productiva.
- **Secretos:** `git ls-files` y nombres de archivos en historia sólo mostraron `.env.example` y `.env.local.example`. Una búsqueda de marcadores de claves en código actual devolvió un fixture de test. No se imprimieron valores. La inspección de historia por patrón no sustituye un escáner de secretos completo; no se confirmó un secreto versionado que obligue rotación.

## Verificación

- Reproducción previa: contenido HTML con MIME y extensión PDF aceptado por validación anterior.
- Tests nuevos: 3/3 para firmas, PDF activo, MIME/extensión y archivo vacío; incluidos en `npm test`.
- `npm test`: 2.871/2.871, 0 fallos. El entorno requirió un shim temporal de `os.userInfo()` para `tsx`, retirado tras la suite.
- `npm run test:admin:browser`: 278/278, 0 fallos.
- `npm run typecheck`: pasó.
- `npm run lint`: 0 errores, 39 warnings preexistentes.
- `npm run build`: pasó.
- `git diff --check`: pasó; Git emitió sólo avisos de conversión LF/CRLF.
- `npm audit --offline`: 0 advisories en caché. `npm audit` en línea: no disponible por acceso al registro.

## Estado

**APROBADO CON OBSERVACIONES para el código local revisado.** Calificación aproximada: **7/10 antes** y **7,5/10 después**. Se corrigió un upload mal validado; faltan verificación remota de RLS/Storage/cookies/unidades y límites de abuso antes de aprobar integralmente la operación de producción.


