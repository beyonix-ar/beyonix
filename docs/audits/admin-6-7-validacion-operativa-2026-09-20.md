# Auditoría 6/7 — validación operativa post-migraciones

Fecha: 2026-09-20. Sin commit, push ni deploy.

## Alcance y veredicto

**NO LISTO PARA PRODUCCIÓN.** Las comprobaciones automatizadas y las operaciones SQL remotas controladas resultaron satisfactorias, pero no se certifica el recorrido completo en navegador con sesiones reales de operador/admin/super_admin ni la creación PROD a sucursal. La Auditoría 6/7 no queda cerrada. No hay un bug crítico de stock identificado pendiente de corrección; los bloqueos son de validación operativa pendiente, detallados en el punto 19.

Se distingue entre componentes reales con HTTP simulado, handlers reales con autenticación/Supabase simulados, SQL real sobre fixtures aisladas, RPC remotas con triggers reales dentro de rollback, y consultas GET al proveedor real. Ninguna de estas capas se presenta como un único E2E autenticado.

## 1. Migraciones y conservación del trabajo

`git status --short` y `npx supabase migration list` se ejecutaron primero. Todas las versiones locales tienen su correspondiente versión remota; última: `20260922130000`. No hay migraciones pendientes. No se aplicaron ni crearon migraciones en esta sesión.

Se guardaron hashes SHA-256 de todos los archivos modificados/sin seguimiento iniciales. La comparación posterior no encontró archivos perdidos ni cambios fuera de los seis archivos existentes editados por esta sesión. Todo el resto del trabajo inicial mantiene el mismo contenido. Esto prueba conservación desde el inicio de esta validación, no permite certificar trabajo perdido antes de ella.

## 2. Mercado Libre

- Componente → helper → handler real: primera revisión con `expectedApprovedAt: null`, corrección con versión vigente y motivo, tres clasificaciones, doble clic y conflicto HTTP 409 con mensaje humano.
- RPC remota: primera revisión 3 recibidas = 1 vendible + 1 con descuento + 1 no vendible; stock normal aumenta sólo 1. Corrección a 2 vendibles ajusta el stock por la diferencia. Motivo ausente y versión desactualizada son rechazados; la versión ajena no se sobrescribe.
- Todo dato remoto sintético fue revertido. La frontera HTTP/Supabase del test de componente es simulada; no se hizo una revisión de una venta productiva real.

## 3. Reemplazos

La UI permite seleccionar ítem, variante, cantidad y garantía, revisar el retiro y confirmar. Los tests verifican el request y la actualización posterior. La ruta POST usa `create_order_replacement`, y las pruebas remotas comprobaron registro, salida exactamente una vez, replay sin nuevo descuento, auditoría central, evento de timeline, bloqueo sin stock y sin recepción, y excepción por garantía. Se inspeccionaron las firmas remotas y los argumentos del handler.

**Coordinar el envío por separado significa que registrar el reemplazo NO crea un envío Andreani, NO genera una segunda etiqueta y NO reutiliza la etiqueta original.** El reclamo tiene una confirmación posterior manual de envío/entrega, que tampoco genera envío ni descuenta stock. No existe integración automática de despacho en este flujo de reemplazo.

## 4. Force-delete

Impactos remotos comprobados sobre datos sintéticos: compra recibida, stock actual/proyectado, ventas posteriores, referencias reales del producto, nombre/SKU y frases de confirmación. No se ejecutaron borrados remotos.

Los tests PGlite ejecutan las funciones de borrado de compra/producto/variante, incluyendo confirmación, conflicto, permisos, conservación/desvinculación del historial, auditoría y replay. Algunas fixtures simplifican triggers ajenos al borrado: no se afirma haber ejecutado el borrado contra todos los triggers productivos. El handler real sólo permite super_admin.

## 5. Permisos

| Capacidad de gestión | Operador | Admin | Super_admin |
|---|---|---|---|
| Catálogo y stock | No | Sí | Sí |
| Finanzas, devoluciones y reemplazos | No | Sí | Sí |
| Configuración | No | Sí | Sí |
| Force-delete y auditoría central | No | No | Sí |

Tests de las rutas reales: operador recibe 403 antes de leer/escribir datos operativos; admin/super_admin superan la autorización y reciben 400 por payload deliberadamente inválido; force-delete rechaza también al admin. La identidad JWT y la lectura de profiles se simulan, no se usaron contraseñas ni sesiones de usuarios reales.

Remoto: auditoría tiene políticas SELECT exclusivas de super_admin. `anon` y `authenticated` no pueden ejecutar las RPC de ML, reemplazo, recepción, reversión, force-delete y búsqueda; service_role sí. La función interna de reemplazo tampoco admite ejecución directa por service_role.

Se corrigió el acceso «Ver auditoría» del dashboard, que antes se mostraba a roles sin esa capacidad. En el remoto consultado existe admin y super_admin; no hay cuenta operador. Falta el recorrido visual autenticado indicado en el punto 19.

## 6. Devoluciones parciales

UI comprobada: «Vendió 5 · Cliente reclama 3 · Recibimos 2 · Queda recibir 1». La siguiente recepción envía 1, no el acumulado. Al recargar con 3 recibidas muestra «Queda recibir 0»; se corrigió la omisión de ese desglose en la tarjeta final.

Remoto con rollback: 2 + 1 unidades vendibles, stock +2 y luego +1; replay no duplica; una cuarta unidad reclamada es rechazada. No se muestra cierre de recepción cuando falta una unidad.

## 7. Ventas externas

Modal probado con motivo, confirmación y bloqueo de doble clic. Muestra producto/SKU, unidades, importe bruto e impacto de stock; aclara que no reintegra dinero automáticamente. Historial muestra motivo, actor, fecha e importe.

Remoto: venta x2, reversión por 2000, actor/fecha/motivo, auditoría y restitución exacta de 2 unidades; misma clave no duplica. Código/API bloquean edición de reversada y borrado externo normal; las consultas/métricas excluyen reversadas. Cobertura financiera de la suite ejecutada.

## 8. Pedidos y errores

Hook/helper reales bajo fallos simulados: 404 → no encontrado; 403 → permisos; red → error técnico; timeout → demora. Retry recupera el pedido. El detalle verifica error antes de interpretar ausencia.

## 9. Notificaciones

El cargador propaga error y el popover muestra error/retry; no presenta un fallo como cero pendientes. Se verificó coexistencia de factura y dos reclamos independientes del mismo pedido, con enlaces a sus pestañas. El cargador usa `keepDistinctOperationalTasks`. Recargas llevan al ancla correspondiente.

## 10. Facturación

Loading/error/empty separados; fallo de carga no muestra «No hay facturas pendientes», retry permite llegar al vacío real. Timeout, red y resultado incierto indican no reemitir hasta revisar/conciliar. Errores de datos fiscales indican corregirlos antes de reintentar. No se emitieron facturas ni NC reales en ARCA.

## 11. Configuración

Fallos de red de load/save simulados sobre el componente real: libera loading/saving, muestra error, permite retry y no guarda defaults tras carga fallida. «Disponible desde» está deshabilitado y derivado de stock bajo + 1. Andreani comercial exige confirmación. Los secretos no se incorporaron a la UI ni al informe.

## 12. Andreani PROD

Configuración local cargada mediante el resolver de Next: conexión QA, cotización PROD y creación PROD. API URL, credenciales, cliente, contrato domicilio, contrato sucursal, sucursal origen y su ID están presentes. El resolver reporta configuración de creación completa. `ANDREANI_ALLOW_PROD_SHIPMENT_CREATION=true` y `ANDREANI_ALLOW_PROD_SHIPMENT_CREATION_IN_DEV=true`; no se modificaron.

La UI identifica explícitamente QA y el ambiente de creación; aclara que QA no valida PROD. Esta lectura de `.env.local` no certifica las variables del futuro runtime desplegado.

Había un envío remoto marcado PROD/created. Se comprobó que es de **domicilio** y que el contrato guardado coincide con el contrato PROD domicilio configurado. Con el cliente real y un guard que sólo admite GET se ejecutaron autenticación, consulta de orden, etiqueta y trazas: estado «Creada», tracking coincidente, PDF de 36786 bytes y 2 eventos. No se expusieron identificadores personales ni se guardó la etiqueta en el repositorio.

No se creó un envío nuevo, no se alteró su estado y no se forzó una reconciliación. La prueba existente no valida creación con el contrato de sucursal ni un ciclo de reconciliación PROD por resultado incierto. Las guardas de creación/reconciliación tienen tests aislados.

## 13. Búsqueda global

La ruta consulta `search_admin_orders`, con paginación server-side. Tests SQL: pedido, nombre de cliente, email, teléfono, producto, SKU, tracking, CAE, factura, referencia de preferencia MP y payment ID; encuentran un pedido fuera de los primeros 50. También validan paginación, comodines literales y denegación a authenticated. Se verificó la función instalada remotamente.

## 14. Auditoría

Se ejercitaron los formatters para venta externa, reversión, reemplazo, NC, refund, reclamo, corrección ML y recepción parcial. Producen títulos y detalles humanos sin abrir JSON. La prueba remota verifica además filas reales de auditoría de recepción/reversión/reemplazo y el evento de timeline del reemplazo.

## 15. Responsive y AdminModal

Edge headless: 1366/1024/390 px sobre el wrapper real usado por ML, ventas y compras; sin overflow del documento ni pérdida de columnas. CSS real de productos probado a 1024 px. AdminModal en JSDOM: role dialog, aria-modal, foco inicial, Tab/trap, exclusión de ocultos y deshabilitados, Escape y restauración.

Límite: no es un recorrido de las cuatro pantallas completas autenticadas en esos tamaños. No se certifica navegación/foco de todos sus modales en navegador mediante este test del wrapper.

## 16. Tests y checks

- `npm test`: **1709 aprobados**, cero fallos/omitidos: pretest 14 + componentes 8 + SQL admin 2 + permisos HTTP 1 + suite principal 1684.
- `npm run test:admin`: aprobado por separado y dentro del pretest final. Incluye tests específicos de Auditoría 6/7.
- `npm run test:admin:browser`: 1 aprobado, Edge headless.
- `npx tsc --noEmit`: aprobado después de las correcciones.
- `npm run lint`: 0 errores, 42 warnings preexistentes.
- `npm run build`: aprobado después de las correcciones, Next 16.3.4; 93 páginas generadas.
- `git diff --check`: aprobado; avisos de conversión LF/CRLF, sin errores de whitespace.
- UTF-8 estricto y búsqueda de mojibake en los archivos de esta sesión: sin errores.
- SQL remoto con rollback: cinco escenarios aprobados (recepción, reemplazo, ML, reversión, impacto de borrado) y comprobación posterior sin registros de prueba.
- Andreani PROD: cuatro requests GET reales (login, orden, etiqueta, trazas), todos satisfactorios.

La primera pasada de la suite original tuvo 1707 tests aprobados. Los tests nuevos agregan autorización de rutas, coexistencia de tareas, mensajes ARCA, estado final de recepción, formatos de auditoría y referencia MP. Los tests simulan fallos deliberados y generan logs de esos fallos esperados; el resultado final es cero tests fallidos.

## 17. Bugs encontrados

1. Dashboard mostraba «Ver auditoría» a roles sin acceso: corregido con `canViewAudit`.
2. Recepción completa ocultaba el desglose 5/3/3/0: corregido y cubierto por el test del componente.

Las fallas intermedias de armado de fixtures (producto sin requisitos comerciales y literal de estado de recepción incorrecto) y de carga de módulos del test se resolvieron; no eran defectos del circuito productivo. No se descubrió un bug crítico que justificara otra migración.

## 18. Cambios adicionales / base de datos / entorno

Archivos de aplicación modificados en esta sesión: `app/admin/sections/dashboard/admin-dashboard.tsx` y `components/claims/admin-claim-manager.tsx`.

Tests ampliados: `lib/admin/admin-error-integration.test.tsx`, `lib/admin/admin-operation-ui.test.tsx`, `lib/admin/admin-order-search.test.ts`. Nuevo: `lib/admin/admin-permissions-integration.test.ts`. `package.json` incorpora este test server-side a `test:admin` y, por pretest, a `npm test`.

Evidencia nueva: este informe, `admin-6-7-validacion-operativa-rollback.sql` y captura de git status. El SQL termina en ROLLBACK, no es una migración ni una fuente alternativa del esquema.

Base de datos: **sin cambios persistentes de datos ni esquema**. Después del rollback se comprobaron cero productos, variantes, pedidos, reclamos, reemplazos, compras, ventas, operaciones de inventario y auditorías de prueba. Las secuencias PostgreSQL pueden consumir IDs durante transacciones revertidas; no se reiniciaron.

Variables de entorno: **sin cambios**. Ningún secreto copiado al repositorio. Ningún borrado real, emisión fiscal, reintegro real ni nuevo envío.

## 19. Bloqueos y prueba manual exacta

Para cerrar la validación operativa completa solicitada:

1. En un entorno controlado con cuentas operador/admin/super_admin y datos aislados, recorrer las pantallas reales y sus modales a 1366, 1024 y 390 px. Comprobar acciones visibles/ocultas y denegación API, abrir revisión ML, reemplazo, reversión, compra y producto; comprobar foco/Tab/Escape/restauración. Los tests de esta sesión validan capas, no sustituyen ese recorrido. No se dispone de sesiones reales de los tres roles en esta ejecución.
2. Validar el runtime que vaya a publicarse y, con autorización operativa para **un envío PROD a sucursal**, usar un pedido controlado elegible, pagado/facturado y con destino sucursal verificado. Confirmar contrato PROD sucursal, cliente y origen; generar una sola vez, registrar el identificador y comprobar que un segundo intento reutiliza el envío. Verificar consulta, etiqueta y tracking. No reutilizar como prueba el envío a domicilio ya existente.
3. Si la creación devuelve resultado incierto, no repetir POST a ciegas: buscar la orden existente en Andreani y usar la conciliación implementada; comprobar mismo identificador y ausencia de duplicados. No provocar deliberadamente un timeout con un envío real.

No se solicita repetir migraciones, reauditar costos ni volver a realizar los tests aprobados. Los 42 warnings de lint preexistentes se mantienen y no son el motivo del veredicto.

## 20. Git status

Captura íntegra en `admin-6-7-validacion-operativa-git-status.txt`. Conserva los cambios previos y agrega únicamente los archivos de validación señalados. No se ejecutaron commit, push, merge, rebase, cambio de rama, reset ni deploy.
