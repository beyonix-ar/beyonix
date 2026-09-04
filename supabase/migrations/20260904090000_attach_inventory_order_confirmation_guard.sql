-- Adjunta el guardián de stock a la confirmación de pago de una orden.
--
-- HALLAZGO
-- `public.validate_inventory_order_confirmation()` existe desde
-- 20260730174000_sellable_conditioned_variants.sql (con soporte de stock
-- condicionado) pero esa migración sólo reemplaza el CUERPO de la función --
-- nunca vuelve a crear el TRIGGER que la conecta a `ordenes`. El único lugar
-- del repositorio que sí hace `create trigger validate_inventory_order_confirmation
-- ... execute function ...` es `supabase/sql/093_unified_inventory_source.sql`,
-- que es el archivo histórico/manual (ver supabase/sql/README.md): no es la
-- fuente de verdad de lo aplicado y puede estar desincronizado.
--
-- Si esa migración manual nunca corrió tal cual contra este proyecto (o si el
-- trigger se perdió en algún momento), NO existe ningún guardián real que
-- impida confirmar una orden como pagada cuando el stock ya no alcanza. Eso
-- afecta directamente:
--   - el webhook de Mercado Pago (processApprovedMercadoPagoOrderPayment):
--     el manejo de "approved_stock_conflict" agregado en
--     lib/mercadopago/order-payment.ts depende PUNTUALMENTE de que este
--     UPDATE levante CHECKOUT_STOCK_INSUFFICIENT -- sin el trigger, nunca lo
--     levanta y el pago se confirma igual, sin importar el stock real;
--   - la aprobación manual de comprobantes de transferencia
--     (app/api/admin/pedidos/[id]/payment-status/route.ts), que marca
--     estado=pagado directamente sin ninguna otra validación de inventario.
--
-- CORRECCIÓN
-- DROP + CREATE (idempotente): si el trigger YA existía (porque el script
-- histórico sí se corrió alguna vez), esto no cambia su comportamiento --
-- misma función, mismos eventos. Si NO existía, esto cierra el hueco. No
-- modifica ninguna migración ya aplicada; sólo adjunta un trigger a una
-- función que ya está definida y ya fue auditada.

begin;

drop trigger if exists validate_inventory_order_confirmation on public.ordenes;
create trigger validate_inventory_order_confirmation
before update of estado, payment_status on public.ordenes
for each row execute function public.validate_inventory_order_confirmation();

comment on trigger validate_inventory_order_confirmation on public.ordenes is
  'Bloquea la transición de una orden hacia un estado que consume stock (pagado/confirmado/etc.) si el stock derivado real ya no alcanza para sus ítems. Sin este trigger, el webhook de Mercado Pago y la aprobación manual de transferencias pueden confirmar pagos sobre stock inexistente sin ningún aviso.';

commit;
