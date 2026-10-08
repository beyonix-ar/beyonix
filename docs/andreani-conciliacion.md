# Conciliación logística Andreani

Migración: `supabase/migrations/20261009120000_andreani_billing_reconciliation.sql`.

## Facturación real: no hay API confirmada

Auditado `lib/andreani/*` y `docs/andreani/*` (cotizador, orden de envío, etiquetas,
tracking, acciones, datos maestros): ninguna API expone lo que Andreani le factura o
liquida a BEYONIX. Los campos `facturaLegal`/`fechaDeFacturacion` de las APIs de envío y
tracking son la factura **del remitente** asociada a pedidos de almacén, no un cargo de
Andreani. Por eso el importe facturado se carga manualmente o por CSV. La fuente `api`
queda reservada en el modelo, sin uso.

## Modelo

`andreani_billing_entries`: un cargo por línea de factura/liquidación, con pedido (o
"Sin pedido asociado"), envío de reclamo, tipo (`outbound` Envío, `return` Devolución,
`exchange_return` Cambio·retiro, `exchange_resend` Cambio·reenvío, `other`), tracking,
importe **con IVA** (las cotizaciones guardadas usan `tarifaConIva`), fecha,
referencia, fuente (`manual`/`csv`), observación y snapshot de las cotizaciones del
pedido al asociarse (nunca se recalcula). RLS activa, sin grants a anon/authenticated;
todo por RPC `service_role` con actor Admin/Super Admin. Altas y correcciones quedan en
`audit_logs` (antes/después) y la corrección exige motivo.

Reemplaza a `ordenes.andreani_billed_*` (un único importe por pedido, nunca cargado);
esas columnas quedan sin uso, no se borraron.

## Matching e idempotencia

- Sólo por tracking que identifique **un** envío (pedido o envío de reclamo). Si no
  existe, es ambiguo o no hay tracking → "Sin pedido asociado"; se asocia a mano con
  motivo. El tipo del envío encontrado manda sobre el del archivo.
- Clave: referencia + (tracking | pedido | importe+fecha) + tipo, sin importar la fuente:
  la misma línea cargada a mano y luego por CSV no se duplica. Mismo cargo con otro
  importe/fecha = conflicto informado, nunca se pisa.

## Estados (regla única en la base)

`andreani_reconciliation_status` compara lo facturado por el **envío original** con la
cotización con bultos reales (o la de checkout si no hubo). Umbrales en
`andreani_reconciliation_thresholds()` (la UI los recibe del resumen):

| Estado | Regla |
|---|---|
| Pendiente | sin facturación de envío |
| Sin referencia | facturado pero el pedido no tenía cotización guardada (legacy) |
| Conciliado | diferencia < $100 |
| Diferencia importante | ≥ $500 (mismo mínimo que la alerta de recotización) o ≥ 5 % |
| Diferencia menor | el resto |

## Importación

Sólo CSV (no XLSX: evita ampliar el uso de `xlsx`, que tiene advisory conocido; Excel
exporta CSV). Máx. 1 MB y 2000 filas; separador `,` `;` o tab; UTF-8 o Windows-1252;
importes `8.500,50` / `8500.50`; fechas `AAAA-MM-DD` o `DD/MM/AAAA`. Columnas
mínimas: tracking, importe, fecha, referencia (+ tipo y observación opcionales), con
mapeo automático por nombre y manual si cambian. Flujo: vista previa (sin escribir) →
importar. El servidor vuelve a parsear y validar todo.

## Admin → Logística

Tabla con facturado, diferencia vs checkout y vs armado, estado y referencia; acción
**Conciliar** por pedido (alta manual + corrección auditada); botón de importación;
lista "Sin pedido asociado". Dashboard: facturado, diferencias, conciliados,
pendientes, diferencia importante y cargos sin pedido, con filtro Desde/Hasta.

Tests: `lib/admin/andreani-billing.test.ts`, `lib/orders/andreani-billing-db.test.ts`,
`lib/admin/new-routes-security.test.ts`.
