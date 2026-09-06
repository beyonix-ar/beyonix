# Reclamos BEYONIX — cierre de auditoría y reauditoría

Fecha: 6 de septiembre de 2026. Base: commit WIP
`f546f176c3b4d8952f0dc2985a79574353924408`.

## Reconstrucción de la sesión anterior

Se ejecutaron `git status`, `git log`, `git show --stat` y revisión de los
diffs del WIP. El working tree inicial estaba limpio. El WIP abarcaba 36
archivos; sus cambios de estilos y páginas informativas se preservaron.
No se hizo commit, push, reset, restore, stash, rebase ni cambio de rama.

La sesión anterior había implementado:

- RPC transaccionales para creación/respuesta del cliente, mutación Admin,
  recepción de inventario y registro del comprobante de reintegro.
- Registro durable `order_claim_operations`, hash de solicitudes, compensación
  de uploads fallidos y cron de limpieza de intentos registrados.
- Control de versión `expectedUpdatedAt`, locks y auditoría transaccional.
- Plazos calculados desde entrega real; tipo de reclamo derivado del motivo;
  validación de productos y cantidades del pedido en servidor y DB.
- Lista permitida de archivos, extensiones y magic bytes; límites de texto;
  bloqueo de roles de comprobante suministrados por el cliente.
- Restricciones económicas y protección de asignación de privilegios en perfiles.
- Retiro de rutas antiguas de devolución y del componente sin callers
  `account-claims-section.tsx`.
- Tests SQL con PGlite y tests de Storage; cuatro migraciones de reclamos.

Quedaban pendientes de acreditar: aplicación de la última migración, verificación
final del remoto, validaciones globales e informe final. El documento previo
`reclamos-2026-09-05.md` sólo contenía la auditoría inicial. No se tomó su relato
como prueba del estado actual de Supabase.

La suite inicial de esta sesión pasó con **862 tests**.

## Migraciones: local contra remoto

Se consultaron el historial remoto, los catálogos PostgreSQL y las definiciones
reales antes de ejecutar SQL. No se volvió a ejecutar una migración ya registrada.

| Versión | Creación | Estado al retomar | Acción en esta sesión |
| --- | --- | --- | --- |
| 20260905130000 | WIP: RLS | Registrada y protección presente | No reaplicada |
| 20260905140000 | WIP: lectura interna | Registrada y policy presente | No reaplicada |
| 20260905150000 | WIP: operaciones atómicas | Registrada; tabla, funciones y protección presentes | No reaplicada |
| 20260906090000 | WIP: transiciones por tipo de caso | Pendiente | Ejecutada y registrada |
| 20260906100000 | Esta sesión: seguridad final | Nueva | Ejecutada y registrada |
| 20260906110000 | Reauditoría: snapshot fiscal | Nueva | Ejecutada y registrada |

La ejecución usó `supabase db query --linked --file`. El SQL de cada archivo y su
inserción en `supabase_migrations.schema_migrations` se ejecutaron en la misma
transacción. El historial guarda el nombre, versión y contenido SQL. No se usó
un push global de migraciones porque existían pendientes ajenas a reclamos:

- `20260903140000_atomic_product_pricing_save.sql`.
- `20260903150000_checkout_stock_reservation_window.sql`.
- `20260903160000_admin_visibility_for_approved_payment_conflicts.sql`.
- `20260904090000_attach_inventory_order_confirmation_guard.sql`.
- `20260905090000_password_reset_rate_limit.sql`.

Estas cinco siguen pendientes y no se alteraron. No quedan migraciones de
reclamos pendientes de esta auditoría.

## Hallazgos y correcciones

**P0:** ninguno comprobado.

**P1 corregidos por el WIP, revisados nuevamente:** escrituras no atómicas;
rollback que podía pisar cambios concurrentes; falta de versión de pantalla;
mutaciones en terminales; selección de garantía para motivos de transporte;
roles de evidencia controlados por el cliente; resoluciones económicas sin
respaldo canónico; escalamiento de rol por INSERT/trigger de email en perfiles.

**P1 adicionales corregidos en esta sesión:**

1. `approve_order_claim_product_change(bigint,uuid)` seguía accesible a `anon`
   y `authenticated`, con SECURITY DEFINER y sin validar actor. Se verificó que
   no tiene callers vigentes: ahora rechaza toda ejecución y se revocó incluso
   el grant de `service_role`. Se conservó la firma; no se borraron datos.
2. Una nota `processing` se convertía automáticamente en `error` a los cinco
   minutos, incluso para otros pedidos. Un timeout fiscal también liberaba la
   reserva. Se eliminó esa liberación automática, se registra punto/número antes
   de solicitar CAE y se conserva `processing` ante resultado incierto.
3. Un retry de una nota parcial podía volver a emitir después del éxito anterior.
   La nueva firma de reserva compara las notas `processing/authorized` que vio
   la pantalla bajo el lock canónico. La firma sin snapshot dejó de ser invocable
   por API. La confirmación conserva el snapshot mientras se reintenta.
4. Se podía cambiar/rechazar una resolución con notas fiscales comprometidas o
   cerrar otra solución con liquidación pendiente. Se bloquean esas mutaciones.
   El cierre de reintegro exige vinculación exacta entre nota y comprobante,
   CAE y ausencia de emisiones/liquidaciones pendientes del reclamo.
5. La recepción del reclamo y la devolución fiscal podían duplicar stock por
   usar distintas claves de origen. Una nota comprometida bloquea nuevas
   recepciones de ese reclamo. La ruta fiscal relee y omite los productos cuya
   recepción canónica ya terminó. Se sigue usando el registro canónico de stock.
6. El reintegro podía registrar notas distintas de las revisadas en la pantalla.
   Ahora exige coincidencia exacta de IDs pendientes bajo lock; importe y notas
   provienen de DB. Se permite registrar notas posteriores pendientes y se
   conserva el total acumulado de comprobantes.
7. Un operador podía intentar eludir permisos cambiando una reposición a `otro`.
   La autorización considera tanto la resolución anterior como la propuesta.

**P2 corregidos:**

- El trigger borraba el badge de una respuesta del cliente en `aprobado`.
  Ahora sólo limpia automáticamente estados terminales.
- `now()` podía producir versiones no crecientes tras esperar locks. La versión
  usa `greatest(clock_timestamp(), old.updated_at + 1 microsecond)`.
- La recepción de inventario admitía reclamos terminales. DB y UI la bloquean.
- Un limpiador tardío podía marcar como limpio otro intento reutilizado. Su CAS
  comprueba también `expires_at` y exige una fila realmente actualizada.
- PDFs parseables podían contener JavaScript/acciones/adjuntos activos. Se
  inspeccionan nombres y objetos decodificados, arrays y diccionarios de streams.
- El polling Admin ignoraba URLs nuevas si no cambiaba el reclamo. Ahora renueva
  las firmas también sin cambios de negocio y conserva renovación para evidencia
  de casos cerrados. La vista previa usa el archivo vigente.
- Un conflicto dejaba referencias de versión obsoletas en formularios. Se recarga
  el caso y se restablece la versión; las decisiones sensibles deben revisarse.
- Se ignoraban errores al guardar acreditaciones y un catch podía degradar una
  liquidación completada. Se verifican errores y se condiciona el fallback.
- Los errores fiscales internos ya no se devuelven crudos al navegador.
- La notificación de respuesta enlaza directamente al seguimiento del pedido.
- Se agregó confirmación explícita al registro de reintegro de cancelación.

**P3 corregidos:** firma de evidencia duplicada y tipos `any` en el listado de
reclamos por pedido; rama vacía después de marcar reintegro; RPC antigua sin
caller que permanecía operativa. Se conserva el retiro previo de rutas con 410.

## Recorrido final cliente → API → DB → Storage → Admin → acciones → cliente

| Área | Resultado verificado |
| --- | --- |
| IDOR/ownership | Autenticación antes de carga; propietario por `usuario_id`; fallback de pedido invitado exige email verificado. Respuestas validan pedido, claim y usuario en API y RPC. Items ajenos fallan sin persistir. |
| Elegibilidad | Motivo determina plazo/tipo; entrega real obligatoria para reclamos formales; cantidades enteras y acotadas; DB impide duplicar casos activos/formales. |
| RLS/policies/grants | RLS en las cuatro tablas; navegador sin INSERT/UPDATE/DELETE/TRUNCATE; sólo SELECT interno en `order_claims` para badge. Mensajes, archivos e intentos pasan por servidor. |
| SECURITY DEFINER | RPC activas con `search_path=public` y ejecución restringida. Rol efectivo desde profiles. RPC antigua y firma fiscal sin snapshot revocadas. |
| Evidencia | Bucket privado, MIME/tamaño en bucket, lista de extensiones, magic bytes, PDF parseado y acciones activas rechazadas; URLs firmadas por servidor por 300 s. No hay policy de navegador que habilite los buckets de evidencia/comprobantes. |
| XSS/mass assignment | Texto renderizado por React; email Admin escapado; campos de mutación permitidos explícitamente; roles/importe/ownership no se toman como autoridad del cliente. |
| Estados | Grafo validado por RPC; consultas y cancelaciones tienen restricciones propias; terminales no admiten escritura de conversación ni recepción; cierres económicos requieren respaldo. |
| Concurrencia | Orden/claim bajo lock; versión de pantalla para mensajes y decisiones; operaciones cliente por hash; snapshots para reintegro y reserva fiscal; retries rechazados o recuperados sin duplicar efectos. |
| Permisos | Operador para atención; Admin/super_admin para decisiones económicas y recepción; excepciones fiscales administrativas continúan reservadas a super_admin. |
| Acciones económicas | Motor canónico de notas, saldo, comprobantes e inventario; sin ejecución real de pagos, ARCA, saldo, cupones, reemplazos o envíos durante las pruebas. Reposición manual exige confirmación Admin; no se simula la existencia de un envío automático. |
| Auditoría | Creación, respuestas, decisiones, reintegro e inventario usan `order_audit_events`; pruebas fuerzan fallo de auditoría y comprueban rollback íntegro. |
| Cliente/Admin | Seguimiento, notificaciones, badge, refresh de conflictos, evidencia firmada e historial terminal revisados. Confirmaciones y permisos de UI acompañan las restricciones de servidor. |
| Código retirado | Componente antiguo eliminado en WIP; return-request y replacement-options responden 410; RPC antigua conservada únicamente como firma inerte sin grants. |

## Verificación real post-migration

Se ejecutó `reclamos-verificacion.sql` en una transacción **read only**. Resultado:
`catalog_assertions_passed`. El archivo `reclamos-2026-09-06-verificacion.json`
guarda catálogos, conteos y hashes del control.

- Se compararon nueve cuerpos de función remotos, incluidas las dos firmas
  fiscales, con las nuevas migraciones locales: todos coinciden tras normalizar
  espacios. Se guardaron hashes SHA-256 de los cuerpos comprobados.
- RLS activa en `order_claims`, `order_claim_messages`, `order_claim_files` y
  `order_claim_operations`.
- Triggers de versión, atención, notificación y guard de perfiles habilitados.
- Foreign keys y checks inspeccionados, todos validados. Índices de relación,
  unicidad de reclamo activo, idempotencia y limpieza presentes.
- Grant autenticado: SELECT de `order_claims`, filtrado por rol interno.
  `service_role` conserva privilegios de backend; no se expone su clave.
- Bucket de evidencia privado con límite de 40 MiB y ocho MIME permitidos.
  `payment-proofs` también privado. Las policies de Storage existentes se
  inspeccionaron: no dan acceso a estos buckets desde el navegador.
- Conteos: **1 reclamo, 2 mensajes, 0 archivos registrados, 17 objetos de evidencia
  sin metadata**. Los objetos históricos no se borraron ni reasociaron.

## Tests y verificaciones finales

- `npm run typecheck`: correcto.
- `npm run lint`: 0 errores, 42 warnings. Se comparó el diagnóstico de los
  archivos modificados contra su contenido WIP usando ESLint sin checkout:
  17 warnings antes y después, mismos mensajes/reglas; ninguno nuevo.
- `npm test`: **872/872**, sin fallos, cancelados ni omitidos.
- `npm run build`: correcto, Next.js 16.2.6, 90 páginas estáticas generadas.
- Suite SQL/Storage específica de reauditoría: **30/30**.
- 13 pruebas HTTP sin sesión sobre build local: 401 en APIs protegidas y cron;
  410 en rutas retiradas. Ninguna ejecutó una operación de negocio.
- `git diff --check` y revisión de UTF-8 en los archivos modificados.

Las pruebas de concurrencia/roles/rollback usan PostgreSQL embebido PGlite con
datos sintéticos. Los permisos, schema y cuerpos de función se comprobaron
además en Supabase real, sin mutar reclamos/pedidos/clientes existentes. No se
presentan estos tests como una prueba multisesión autenticada del navegador
contra producción.

## Deuda y límites pendientes

1. **P2 histórico:** 17 objetos sin metadata requieren identificación documental
   antes de decidir su destino. Se preservaron expresamente.
2. **P3 existente:** warnings de lint del proyecto. No se emprendió un refactor
   general para eliminarlos.
3. Cinco migraciones ajenas a reclamos pendientes, listadas arriba.
4. Publicar coordinadamente backend y frontend sigue a cargo del usuario. La DB
   ya exige snapshots en las operaciones financieras; una versión antigua de
   la aplicación no puede usar las firmas o payloads retirados. No hubo deploy.
5. Prueba autenticada en navegador y prueba controlada de integraciones reales
   no ejecutadas. No se enviaron emails de prueba reales ni se solicitaron CAE,
   pagos, reintegros, movimientos de saldo/inventario o envíos productivos.
6. La validación de archivos no equivale a un servicio antivirus. Se verificaron
   los formatos, firmas y acciones activas de PDF cubiertos por el código.
7. Ante resultado fiscal incierto se requiere conciliación del comprobante
   intentado: no se habilita un reintento económico automático por timeout.

**Cierre:** no quedan P0/P1 identificados sin corregir en el código auditado y
las migraciones aplicadas. Esto no certifica una publicación todavía no realizada
ni integraciones económicas que no se ejecutaron por instrucción del usuario.

Variables de entorno agregadas o modificadas en esta sesión: **ninguna**.
No se borraron datos ni recursos productivos.

## Archivos modificados en esta sesión

Código y pruebas:

- `app/admin/sections/pedidos/admin-pedidos.tsx`
- `app/api/admin/orders/[id]/credit-note/route.ts`
- `app/api/admin/orders/[id]/credit-note/settlement/route.ts`
- `app/api/admin/pedidos/[id]/claims/route.ts`
- `app/api/admin/pedidos/[id]/refund/route.ts`
- `app/api/orders/[id]/claims/route.ts`
- `components/claims/admin-claim-manager.tsx`
- `components/claims/customer-claim-experience.tsx`
- `lib/order-claims.ts`
- `lib/orders/claim-atomic.test.ts`
- `lib/orders/claim-server.ts`
- `lib/orders/claim-storage.test.ts`
- `lib/orders/fixtures/claim-schema.sql`

Archivos nuevos:

- `supabase/migrations/20260906100000_claims_final_security.sql`
- `supabase/migrations/20260906110000_claim_credit_note_snapshot.sql`
- `docs/audits/reclamos-2026-09-06-final.md`
- `docs/audits/reclamos-2026-09-06-verificacion.json`
- `docs/audits/reclamos-verificacion.sql`

La migración `20260906090000` se ejecutó sin editar el archivo existente del WIP.
