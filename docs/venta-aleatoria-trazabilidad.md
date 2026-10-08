# Venta aleatoria: trazabilidad física

Migración: `supabase/migrations/20261009100000_random_fulfillment_traceability.sql`.

## Datos

| Dato | Dónde | Notas |
|---|---|---|
| Variante reservada | `orden_items.reserved_variant_id` | La fija la base al insertar el renglón (trigger), inmutable. Sin FK a propósito (evita embeds PostgREST ambiguos). |
| Variante que consume stock | `orden_items.variante_id` | El ledger (`inventory_movements`) deriva la venta web de esta columna. |
| Variante física despachada | `order_preparation_scans.physical_variant_id` | Por escaneo y por intento de armado (`attempt_number`). |
| Cómo se identificó | `order_preparation_scans.variant_identification` | `variant_code` (el código identifica la variante) o `group_confirmed` (código de grupo + confirmación del operador). |
| Reasignación | `order_preparation_scans.reassigned_from_variant_id` + evento `random_variant_assigned` | |
| Auditoría | `order_audit_events`: `random_variant_assigned`, `random_variant_dispatched` | reservada, despachada, intento, código, reasignación, actor, fecha. |

Cada unidad aleatoria es un renglón de 1 unidad (checkout), así que la variante
física de un renglón armado es exactamente la de su escaneo.

## Stock

Cambiar `variante_id` al armar es un solo `UPDATE` bajo el lock por producto
(`pg_advisory_xact_lock(93000, producto)`, el mismo de reservas y refresh): el trigger
`refresh_inventory_after_order_item` devuelve la unidad a la variante anterior y la
consume de la nueva en la misma transacción. La variante nueva necesita una unidad
**libre**: stock derivado (ya descuenta lo vendido a otros pedidos) menos reservas de
checkout vigentes. Si no hay, `DISPATCH_RANDOM_VARIANT_NO_STOCK` y nada cambia.
`refresh_inventory_stock` es fail-closed: nunca deja stock negativo.

## Código de grupo

EAN común, alias sin variante o SKU del producto **no** identifican el color. En un
renglón aleatorio pendiente, `scan_order_preparation_code` responde
`requiresVariant: true` con las variantes candidatas y **no registra nada**. El panel
muestra "¿Qué variante física estás despachando?"; la confirmación reenvía el código
con `p_variant_id`. La base valida que la variante sea del producto, esté activa,
coincida con el código (si el código es de variante), no exceda cantidad y tenga stock
libre. Un pedido no aleatorio nunca acepta código de grupo ni confirmación manual.
Reintento con la misma clave = idempotente; misma clave con otra variante = conflicto.

## Cancelación, devolución, rearmado

- Cancelación antes del despacho: el pedido deja de consumir stock y la unidad vuelve a
  `variante_id` (la física si ya se armó, la reservada si no).
- Devolución: la recepción usa `orden_items.variante_id` → vuelve a la variante que salió.
- Rearmado: `reset_order_preparation` sube el intento; los escaneos anteriores quedan con
  su `attempt_number` (R1 Rojo, R2 Azul).

Tests: `lib/orders/catalog-random-db.test.ts`.
