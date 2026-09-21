-- Auditoría 5/7 (dashboard/reportes), Fase 4, punto 10.
--
-- P1 confirmado: external_sales no tenía ninguna columna ni flujo de
-- reversión/refund -- la única forma de "deshacer" una venta externa era
-- editarla o borrarla a mano (sin motivo obligatorio, sin auditoría propia:
-- external_sales nunca tuvo el trigger genérico audit_log_change adjunto,
-- a diferencia de inventory_return_movements/orden_items/product_cost_
-- entries). Eso deja sin rastro por qué una venta externa dejó de contar.
--
-- Diseño elegido: mínimo pero real, reutilizando la infraestructura de stock
-- ya auditada -- NO se reinventa el manejo de stock. inventory_movements
-- (vista, ver 20260801104000_inventory_single_source_and_repair.sql:148) ya
-- lee external_sales en vivo con "where sales.product_id is not null"; sólo
-- se agrega "and sales.status <> 'reversed'" a esa rama. Como
-- refresh_inventory_after_external_sale (after insert/update/delete, ver
-- 20260918150000) ya dispara refresh_inventory_stock() ante cualquier UPDATE
-- de la fila, marcar status='reversed' hace que el próximo refresh recalcule
-- sin esa venta -- sin tocar cantidad/costo, sin reingresar stock a mano, sin
-- riesgo de doble reingreso (la fila nunca se borra, sólo cambia de estado).
--
-- La API administrativa deja de exponer DELETE para este canal: una venta
-- real o cargada por error se reversa con motivo y conserva el historial.
-- reverse_external_sale() registra actor, fecha, importe y clave idempotente.

begin;

alter table public.external_sales
  add column if not exists status text not null default 'completed',
  add column if not exists reversed_at timestamptz,
  add column if not exists reversed_by uuid references auth.users(id) on delete set null,
  add column if not exists reversal_reason text,
  add column if not exists reversal_amount numeric(12,2),
  add column if not exists reversal_idempotency_key text;

alter table public.external_sales
  drop constraint if exists external_sales_status_check,
  add constraint external_sales_status_check
    check (status in ('completed', 'reversed'));

alter table public.external_sales
  drop constraint if exists external_sales_reversal_reason_check,
  add constraint external_sales_reversal_reason_check check (
    (
      status = 'completed'
      and reversed_at is null
      and reversed_by is null
      and reversal_reason is null
      and reversal_amount is null
      and reversal_idempotency_key is null
    )
    or (
      status = 'reversed'
      and reversed_at is not null
      and reversal_reason is not null
      and length(btrim(reversal_reason)) >= 10
      and reversal_amount is not null
      and reversal_amount >= 0
      and reversal_idempotency_key is not null
    )
  );

create unique index if not exists external_sales_reversal_idempotency_key_uidx
  on public.external_sales (reversal_idempotency_key)
  where reversal_idempotency_key is not null;

create or replace view public.inventory_movements
with (security_invoker = true)
as
select
  entries.product_id, entries.variant_id, entries.purchase_date as movement_date,
  entries.created_at as recorded_at, 'purchase'::text as source,
  entries.id::text as source_id, entries.received_quantity::bigint as quantity_delta,
  'purchase:' || entries.id::text as movement_id,
  'purchase'::text as movement_type,
  'product_cost_entries'::text as origin,
  entries.purchase_date::timestamp at time zone 'America/Argentina/Buenos_Aires' as effective_at,
  entries.created_by as responsible_user_id,
  'admin_purchase'::text as responsible_process,
  coalesce(entries.idempotency_key, 'purchase:' || entries.id::text) as idempotency_key,
  coalesce(nullif(btrim(entries.document_number), ''), entries.id::text) as document_reference
from public.product_cost_entries entries
where entries.product_id is not null and entries.received_quantity <> 0

union all

select
  items.producto_id, items.variante_id,
  (orders.created_at at time zone 'America/Argentina/Buenos_Aires')::date,
  orders.created_at, 'web_sale'::text, items.id::text, -items.cantidad::bigint,
  'web_sale:' || items.id::text, 'web_sale'::text, 'orden_items'::text,
  orders.created_at, orders.usuario_id, 'checkout'::text,
  coalesce(orders.checkout_idempotency_key, 'order-item:' || items.id::text),
  'order:' || orders.id::text
from public.orden_items items
join public.ordenes orders on orders.id = items.orden_id
where items.conditioned_stock_id is null
  and public.inventory_order_consumes_stock(orders.estado, orders.payment_status)

union all

select
  sales.product_id, sales.variant_id, sales.sale_date, sales.created_at,
  'external_sale'::text, sales.id::text, -sales.quantity::bigint,
  'external_sale:' || sales.id::text, 'external_sale'::text, 'external_sales'::text,
  sales.sale_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
  sales.created_by, 'admin_external_sale'::text,
  'external-sale:' || sales.id::text,
  coalesce(nullif(btrim(sales.reference), ''), sales.id::text)
from public.external_sales sales
where sales.product_id is not null
  and sales.status <> 'reversed'

union all

select
  sales.product_id, public.inventory_ml_variant_id(sales.raw_data),
  coalesce(
    (sales.sale_date at time zone 'America/Argentina/Buenos_Aires')::date,
    (sales.imported_at at time zone 'America/Argentina/Buenos_Aires')::date
  ),
  sales.imported_at, 'mercadolibre_sale'::text, sales.id::text,
  -public.inventory_ml_stock_units(sales.quantity, sales.raw_data)::bigint,
  'mercadolibre_sale:' || sales.id::text, 'mercadolibre_sale'::text,
  'mercadolibre_sales'::text, coalesce(sales.sale_date, sales.imported_at),
  sales.imported_by, 'mercadolibre_import'::text,
  coalesce(sales.source_key, 'mercadolibre-sale:' || sales.id::text),
  coalesce(nullif(btrim(sales.operation_id), ''), nullif(btrim(sales.order_id), ''), sales.id::text)
from public.mercadolibre_sales sales
where sales.product_id is not null
  and public.inventory_ml_stock_units(sales.quantity, sales.raw_data) > 0

union all

select
  movements.product_id, movements.variant_id,
  (movements.occurred_at at time zone 'America/Argentina/Buenos_Aires')::date,
  movements.created_at, 'approved_return'::text, movements.id::text,
  movements.sellable_quantity::bigint,
  'approved_return:' || movements.id::text, 'return'::text,
  'inventory_return_movements'::text,
  coalesce(movements.occurred_at, movements.approved_at, movements.created_at),
  movements.approved_by, 'return_review'::text,
  movements.source_key,
  coalesce(
    case when movements.mercadolibre_sale_id is not null
      then 'mercadolibre-sale:' || movements.mercadolibre_sale_id::text end,
    case when movements.order_item_id is not null
      then 'order-item:' || movements.order_item_id::text end,
    movements.id::text
  )
from public.inventory_return_movements movements
where movements.sellable_quantity <> 0

union all

select
  expenses.product_id, expenses.variant_id, expenses.expense_date,
  expenses.created_at, 'product_expense'::text, expenses.id::text,
  -expenses.quantity::bigint,
  'product_expense:' || expenses.id::text, 'write_off'::text,
  'business_expenses'::text,
  expenses.expense_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
  expenses.created_by, 'admin_product_expense'::text,
  coalesce(expenses.idempotency_key, 'product-expense:' || expenses.id::text),
  coalesce(nullif(btrim(expenses.document_number), ''), expenses.id::text)
from public.business_expenses expenses
where expenses.expense_type = 'product'
  and expenses.product_id is not null
  and expenses.quantity is not null

union all

select
  adjustments.product_id, adjustments.variant_id, adjustments.adjustment_date,
  adjustments.created_at, 'stock_adjustment'::text, adjustments.id::text,
  adjustments.quantity_delta::bigint,
  'stock_adjustment:' || adjustments.id::text, 'adjustment'::text,
  'inventory_stock_adjustments'::text,
  adjustments.created_at, adjustments.created_by, 'admin_stock_adjustment'::text,
  coalesce(adjustments.idempotency_key, 'stock-adjustment:' || adjustments.id::text),
  adjustments.reason
from public.inventory_stock_adjustments adjustments
where adjustments.quantity_delta <> 0;

grant select on public.inventory_movements to authenticated, service_role;

create or replace function public.reverse_external_sale(
  p_id uuid,
  p_reason text,
  p_actor_id uuid,
  p_idempotency_key text
)
returns public.external_sales
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_sale public.external_sales%rowtype;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para reversar esta venta.';
  end if;

  if p_actor_id is null then
    raise exception 'EXTERNAL_SALE_REVERSAL_ACTOR_REQUIRED';
  end if;

  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;

  if v_reason is null or length(v_reason) < 10 then
    raise exception 'Indicá el motivo de la reversión (mínimo 10 caracteres).';
  end if;

  perform pg_advisory_xact_lock(hashtext('external-sale-reversal'), hashtext(p_id::text));

  select * into v_sale from public.external_sales where id = p_id for update;
  if not found then
    raise exception 'La venta externa ya no existe.';
  end if;

  if v_sale.status = 'reversed' then
    if v_sale.reversal_idempotency_key = v_key then
      return v_sale;
    end if;
    raise exception 'EXTERNAL_SALE_ALREADY_REVERSED';
  end if;

  if v_sale.product_id is not null then
    perform pg_advisory_xact_lock(93000, v_sale.product_id::integer);
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  update public.external_sales
  set status = 'reversed',
      reversed_at = now(),
      reversed_by = p_actor_id,
      reversal_reason = v_reason,
      reversal_amount = greatest(coalesce(v_sale.gross_amount, 0), 0),
      reversal_idempotency_key = v_key
  where id = p_id
  returning * into v_sale;

  return v_sale;
end;
$$;

revoke all on function public.reverse_external_sale(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.reverse_external_sale(uuid, text, uuid, text)
  to service_role;

comment on function public.reverse_external_sale(uuid, text, uuid, text) is
  'Reversión formal de una venta externa (cancelación/devolución real, no un error de tipeo): exige motivo, queda auditada, es idempotente y reintegra stock automáticamente vía el trigger refresh_inventory_after_external_sale + la exclusión de status=reversed en inventory_movements. Auditoría 5/7.';

-- Mismo trigger genérico ya usado en inventory_return_movements/orden_items
-- (ver 20260920100000): external_sales nunca lo tuvo adjunto -- ninguna
-- edición ni el DELETE manual quedaba en audit_logs.
drop trigger if exists external_sales_audit_log_trigger on public.external_sales;
create trigger external_sales_audit_log_trigger
after insert or update or delete on public.external_sales
for each row execute function public.audit_log_change();

notify pgrst, 'reload schema';

commit;
