# Auditoría 6/7 — recuperación del panel administrativo

Fecha: 2026-09-20. Veredicto: **NO LISTO para producción** hasta verificar el esquema remoto y completar la prueba operativa controlada indicada en pendientes.

## 1. Trabajo previo encontrado

Se ejecutaron primero `git status --short`, `git diff --stat` y `git diff`. Había 48 archivos versionados modificados y numerosos archivos sin seguimiento. El estado estaba más avanzado que el transcript: ya existían confirmaciones de borrado, UI de reemplazos, errores/retry, capacidades, búsqueda global, responsive y tests. También estaban acumulados cambios de costos, stock, devoluciones, notas de crédito y ventas externas de auditorías anteriores.

Se preservó todo ese trabajo. No se usó reset, checkout, cambio de rama, commit, push, deploy ni db push. No se puede atribuir cada cambio previo a una sesión específica únicamente a partir del working tree.

## 2. Qué estaba incompleto

- Mercado Libre tenía control optimista pero no bloqueo inmediato contra doble envío; UI/helper aceptaban motivos más cortos que SQL.
- Las pruebas no recorrían todavía el componente ML hasta el handler HTTP real.
- Los tests de borrado SQL ejecutaban compra; producto/variante sólo tenían comprobada su frase de confirmación.
- Configuración, consulta de facturación y diagnóstico de notificaciones no tenían timeout de fetch.
- La sustitución de la acción de entrega por retiro de stock había quitado la confirmación específica de envío/entrega del reemplazo.
- La búsqueda de variantes de reemplazo podía aceptar una respuesta anterior fuera de orden.
- Los reemplazos tenían timeline de pedido pero no registro propio en la auditoría central.
- Las recargas apuntaban al listado general; la emisión desde el pedido todavía exponía mensajes técnicos de ARCA.
- El importe mostrado antes de reversar una venta externa usaba neto, mientras la RPC registra el bruto revertido.
- El trap de foco no excluía controles ocultos por CSS ni controles dentro de un fieldset deshabilitado.

## 3. Qué se terminó en esta recuperación

Se corrigieron esos puntos sobre los archivos existentes, se ampliaron pruebas funcionales y SQL y se preparó una migración nueva exclusivamente para la auditoría central de reemplazos. Los apartados siguientes describen el resultado acumulado y distinguen sus límites de verificación.

## 4. Force-delete

`ForceDeleteDialog` usa impacto calculado por servidor, frase exacta, fingerprint e idempotencia. La compra muestra producto/variante, unidades recibidas, costo, ventas posteriores, stock actual/proyectado y advertencia contable. Producto/variante muestran referencias e historial afectados. La API exige super_admin y los endpoints anteriores rechazan `force` sin el nuevo circuito.

Se ejecutaron las funciones SQL reales de compra/producto/variante en PGlite: frase incorrecta, conflicto, permisos, borrado, historial conservado/desvinculado, auditoría y replay. Los triggers ajenos al propósito de algunas fixtures son simplificados; no equivale a ejecutar contra todo el esquema productivo.

## 5. Permisos

Se conserva `lib/admin/admin-capabilities.ts` como helper. Productos, pedidos, devolución y reemplazos ocultan acciones según capacidad. Dashboard ahora consulta también ese helper para sus acciones financieras. Las rutas administrativas conservan los controles backend. Tests de capacidades para operador/admin/super_admin; el test ML comprueba admin y super_admin admitidos y operador rechazado antes de la RPC.

## 6. Mercado Libre

Primera revisión manda `expectedApprovedAt: null`; corrección manda el `approved_at` visto y motivo de al menos tres caracteres. Conflicto devuelve 409 y el mensaje humano solicitado, con recarga. Bloqueo síncrono contra doble envío y timeout. Prueba del componente real → helper real → handler HTTP real, con frontera Supabase simulada; las reglas SQL se prueban aparte con PGlite. Incluye clasificación vendible, con descuento y no vendible.

## 7. Reemplazos

Se reutiliza POST `/api/admin/pedidos/[id]/replacements`. La UI permite elegir ítem, variante, cantidad, motivo y garantía; muestra stock actual/resultante y confirmación del retiro. Conserva idempotencia ante resultado incierto. Las recargas descartan respuestas antiguas y no permiten usar datos de una consulta fallida. El éxito refresca historial y pedido/timeline. La migración nueva agrega auditoría central con actor/email y sin exponer la clave de idempotencia.

Se recuperó la confirmación separada de envío/entrega del reclamo. El reemplazo no crea un envío Andreani automático ni reutiliza la etiqueta original: se coordina la entrega por separado, como informa la UI.

## 8. Devoluciones

Se muestran vendido/reclamado/recibido/remanente. Se registran cantidades de la entrega actual y no el acumulado. El remanente permite recepciones sucesivas. La prueba de componente verifica vendido 5, reclamado 3, recibido 2, pendiente 1 y la nueva recepción de una unidad. El progreso de entrega usa estados reales del reclamo.

## 9. Ventas externas

Modal con producto, SKU, unidades, importe bruto que revierte la RPC, impacto de stock, motivo y advertencia de que no reintegra dinero automáticamente. Después se muestra motivo, fecha, actor e importe. Se conserva el backend idempotente y el historial. Prueba real del modal, motivo y doble clic; SQL de reversión cubierto por la suite anterior preservada.

## 10. Pedidos

404, permisos, red y timeout tienen mensajes diferentes; hay retry. Se ejercita `usePedidos` con el helper/fetch real en cada caso y recuperación exitosa. La vista detalle comprueba error antes de mostrar pedido ausente.

## 11. Notificaciones

Los errores de carga se propagan, no se convierten en resumen cero. Campana/popover tienen error y retry; el hook distingue loading/error/loaded/empty y activa loading también al reintentar. Se conservan tareas independientes del pedido. Las recargas enlazan a `#topup-ID`, con scroll/foco cuando aparece la fila. El test llama al cargador real ante fallo de autenticación/red y verifica rechazo; también renderiza el estado de error del popover.

## 12. Facturación

Loading/error/empty separados y retry. Timeout en consulta. Mensajes ARCA humanos también en emisión/NC dentro del pedido; resultado incierto pide comprobar autorización antes de volver a emitir. No se emitieron comprobantes reales.

## 13. Configuración

Load/save usan try/catch/finally, timeout y bloqueo de guardado si la carga inicial falló. Tests verifican liberación de loading/saving. “Disponible desde” está deshabilitado y se deriva de Stock bajo + 1. Los campos de envío predeterminado, recargo y mínimo de recargas MP tienen UI. Andreani comercial exige confirmación. No se agregaron ni modificaron variables de entorno.

## 14. Andreani

La prueba se identifica explícitamente como QA; muestra ambiente del resultado y aclara que QA no valida PROD. Se preservaron las defensas de creación/reconciliación. No se ejecutó ninguna prueba de conexión ni envío externo en esta recuperación.

## 15. Auditoría

Formatters humanos existentes para venta/reversión externa, reemplazo, NC, refund y reclamo. Las correcciones ML muestran sus notas/motivo en el movimiento real de devolución. Compras muestran received_quantity/reception_status y remanente. La nueva migración hace visible el reemplazo en auditoría central además del evento del pedido.

## 16. Búsqueda

Consulta global server-side mediante `search_admin_orders`, paginada; busca identificador público/interno, datos de cliente, producto/SKU, tracking, factura/CAE y referencias de pago. El test SQL busca un pedido fuera de los primeros 50, verifica paginación, caracteres literales y denegación a authenticated.

## 17. Responsive y modal

ML, ventas externas y compras usan el wrapper responsive existente; productos conserva sus tarjetas. Prueba de navegador sobre el wrapper real y CSS de productos a 1366, 1024 y 390 px: sin overflow horizontal del documento ni pérdida de celdas. No sustituye una prueba E2E autenticada de cada pantalla con datos reales.

AdminModal tiene semántica accesible, foco inicial, trap, Escape y restauración. Se corrigió la exclusión de controles ocultos por CSS/fieldset deshabilitado y se comprobó funcionalmente. Se mantienen indicadores de progreso operativo de recepción/NC/reintegro donde corresponde.

## 18. Tests

- ML: componente/helper/API real, doble clic, tres clasificaciones, revisión/corrección/conflicto y roles.
- Reemplazo: componente con retiro confirmado; SQL real de stock, costo histórico, recepción, garantía, límites acumulados, idempotencia y auditoría.
- Capacidades: operador/admin/super_admin; rechazo HTTP de operador en ML.
- Notificaciones: error del cargador no devuelve cero; componente muestra error/retry.
- Facturación: error no muestra vacío, retry recupera estado vacío válido.
- Pedidos: hook/helper distinguen red, timeout, 403 y 404; retry exitoso.
- Configuración: loading/saving se liberan; no guarda defaults ante fallo inicial.
- Compra/producto/variante: confirmación tipada en componente; funciones SQL reales.
- Venta externa: motivo obligatorio, confirmación, doble clic e historial de reversión.
- Parciales: remanente visible y envío de la nueva cantidad solamente.
- Modal: foco, Tab, ocultos/deshabilitados, Escape y restauración.
- Búsqueda: tracking, factura/CAE, SKU, MP, cliente y paginación global en SQL.
- Responsive: navegador real en tres anchos; alcance indicado arriba.

## 19. Checks

- `npm test`: OK. Pretest 14 + componentes/admin 7 + SQL admin 2 + suite principal 1684 = **1707 tests**, cero fallos y cero omitidos.
- `npm run test:admin`: repetido después del último ajuste del control de cargas, OK (9 tests).
- `npm run test:admin:browser`: OK (1 test, Edge headless; 1366/1024/390 px).
- `npx tsc --noEmit`: OK.
- `npm run lint`: OK, 0 errores y 42 warnings; misma cantidad que al recuperar el árbol. Se corrigió el warning nuevo introducido durante esta recuperación.
- `npm run build`: OK después del último cambio de código.
- `git diff --check`: OK; Git advierte sobre conversión LF/CRLF en archivos acumulados, sin errores de whitespace.
- Revisión UTF-8 de 81 fuentes modificadas/nuevas no-test: sin coincidencias de mojibake.
- `git status --short`: revisado; captura completa abajo.
- No se instalaron dependencias adicionales en esta recuperación. Las dependencias DEV de pruebas ya estaban en el working tree al iniciar.

## 20. Migraciones nuevas / base de datos

Nueva en esta recuperación: `20260922130000_replacement_admin_audit.sql`. Probada en PGlite, **no aplicada al remoto**.

Ya estaban al iniciar las tres migraciones de admin: `20260922100000_admin_confirmed_force_delete.sql`, `20260922110000_admin_order_search.sql` y `20260922120000_replacement_operation_guard.sql`, además de doce migraciones de auditorías anteriores. Estar sin seguimiento de Git no determina si una migración se aplicó remotamente. Esta sesión no consultó el historial remoto ni aplicó ninguna migración; hay que conciliar ese estado antes de publicar el código dependiente de esas RPC.

## 21. Riesgos / pendientes

- Verificar la correspondencia de migraciones locales/remotas y aplicar lo pendiente mediante el proceso de publicación autorizado. No se hizo db push.
- Prueba operativa controlada con roles reales, datos representativos y servicios externos; Andreani PROD continúa pendiente de validar credenciales/contrato/sucursal reales.
- El envío del reemplazo requiere coordinación separada; no hay generación automática de una segunda etiqueta en este circuito.
- Persisten warnings del lint del árbol acumulado; se informan en los checks. No se hizo una limpieza general fuera de alcance.
- Las pruebas SQL usan fixtures aisladas y las pruebas HTTP simulan Supabase; no certifican por sí mismas todo el esquema ni las integraciones productivas.

## 22. git status --short

```text
 M app/admin/admin-client.tsx
 M app/admin/components/admin-controls.tsx
 M app/admin/sections/auditoria/audit-helpers.ts
 M app/admin/sections/clientes/admin-clientes.tsx
 M app/admin/sections/dashboard/admin-costs-panel.tsx
 M app/admin/sections/dashboard/admin-dashboard.tsx
 M app/admin/sections/dashboard/admin-mercadolibre-sales.tsx
 M app/admin/sections/dashboard/admin-sales-ledger.tsx
 M app/admin/sections/facturacion/admin-facturacion.tsx
 M app/admin/sections/modificaciones/admin-modificaciones.tsx
 M app/admin/sections/modificaciones/andreani-integration-card.tsx
 M app/admin/sections/pedidos/admin-pedidos.tsx
 M app/admin/sections/productos/admin-productos.tsx
 M app/admin/sections/productos/productos-row.tsx
 M app/admin/sections/productos/productos-toolbar.tsx
 M app/api/admin/conditioned-stock/[id]/route.ts
 M app/api/admin/costs/route.ts
 M app/api/admin/dashboard/route.ts
 M app/api/admin/mercadolibre-sales/[id]/return-review/route.ts
 M app/api/admin/mercadolibre-sales/route.ts
 M app/api/admin/orders/[id]/credit-note/route.ts
 M app/api/admin/pedidos/[id]/return-inventory/[itemId]/route.ts
 M app/api/admin/pedidos/route.ts
 M app/api/admin/products/[id]/route.ts
 M app/api/admin/products/[id]/variants/[variantId]/route.ts
 M app/api/admin/sales-ledger/route.ts
 M components/admin-notification-bell.tsx
 M components/admin-notifications-popover.tsx
 M components/claims/admin-claim-manager.tsx
 M hooks/use-admin-notifications.ts
 M hooks/use-pedidos.ts
 M lib/admin/admin-notification-rules.ts
 M lib/admin/admin-notifications.ts
 M lib/business/commercial-circuit-consistency.test.ts
 M lib/business/idempotency-attempt.ts
 M lib/business/product-costs.test.ts
 M lib/business/product-costs.ts
 M lib/business/standalone-cost-items.ts
 M lib/mercadolibre/sale-costing.ts
 M lib/orders/claim-server.ts
 M lib/supabase/queries/business-costs.ts
 M lib/supabase/queries/dashboard.ts
 M lib/supabase/queries/mercadolibre-sales.ts
 M lib/supabase/queries/pedidos.ts
 M lib/supabase/queries/sales-ledger.ts
 M lib/supabase/types.ts
 M next-env.d.ts
 M package-lock.json
 M package.json
?? app/admin/components/admin-responsive-table.tsx
?? app/admin/components/force-delete-dialog.tsx
?? app/admin/components/operational-progress.tsx
?? app/admin/sections/pedidos/order-replacements.tsx
?? app/api/admin/destructive-operations/
?? app/api/admin/pedidos/[id]/replacements/
?? app/api/admin/sales-ledger/[id]/
?? docs/audits/admin-6-7-recuperacion-2026-09-20.md
?? lib/admin/admin-capabilities.ts
?? lib/admin/admin-destructive-sql.test.ts
?? lib/admin/admin-error-integration.test.tsx
?? lib/admin/admin-ml-integration.test.tsx
?? lib/admin/admin-operation-ui.test.tsx
?? lib/admin/admin-order-search.test.ts
?? lib/admin/admin-responsive.browser.test.tsx
?? lib/admin/billing-errors.ts
?? lib/admin/destructive-operations.ts
?? lib/admin/modal-focus.ts
?? lib/admin/order-operational-progress.ts
?? lib/admin/request-error.ts
?? lib/business/dashboard-financials.test.ts
?? lib/business/dashboard-financials.ts
?? lib/business/dashboard-timezone.test.ts
?? lib/business/dashboard-timezone.ts
?? lib/business/dashboard-ui-contract.test.ts
?? lib/business/external-sale-reversal.test.ts
?? lib/business/fixtures/
?? lib/business/historical-cost-snapshot.test.ts
?? lib/business/purchase-cost-audit.test.ts
?? lib/business/return-profitability.test.ts
?? lib/business/return-profitability.ts
?? lib/business/standalone-cost-items.test.ts
?? lib/mercadolibre/return-review-client.ts
?? lib/mercadolibre/return-review-immutability.test.ts
?? lib/orders/credit-note-reception.test.ts
?? lib/orders/credit-note-reception.ts
?? lib/orders/fixtures/return-reception-schema.sql
?? lib/orders/order-replacements.test.ts
?? lib/orders/return-reception-unification.test.ts
?? supabase/migrations/20260918140000_historical_cost_snapshot.sql
?? supabase/migrations/20260918150000_purchase_inventory_refresh_reproducibility.sql
?? supabase/migrations/20260918160000_attach_purchase_cost_audit_trigger.sql
?? supabase/migrations/20260918170000_force_delete_purchase_impact_check.sql
?? supabase/migrations/20260918180000_revoke_direct_writes_on_product_cost_entries.sql
?? supabase/migrations/20260919100000_deterministic_historical_cost_snapshot.sql
?? supabase/migrations/20260920100000_inventory_return_movements_reproducibility.sql
?? supabase/migrations/20260920110000_unify_return_reception_rpc.sql
?? supabase/migrations/20260920120000_ml_return_review_immutability.sql
?? supabase/migrations/20260920130000_credit_note_reception_exception_reason.sql
?? supabase/migrations/20260920140000_order_replacements.sql
?? supabase/migrations/20260921100000_external_sale_reversal.sql
?? supabase/migrations/20260922100000_admin_confirmed_force_delete.sql
?? supabase/migrations/20260922110000_admin_order_search.sql
?? supabase/migrations/20260922120000_replacement_operation_guard.sql
?? supabase/migrations/20260922130000_replacement_admin_audit.sql
```
