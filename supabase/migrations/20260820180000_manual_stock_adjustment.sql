-- Corrección manual de stock por variante, disponible desde Productos.
-- El admin puede necesitar corregir la cantidad real (unidades falladas,
-- error de carga, recuento físico) sin que exista una compra o una venta.
-- Se modela como una fuente más de inventory_movements (igual que compras,
-- ventas, devoluciones o bajas), nunca como una escritura directa sobre
-- producto_variantes.stock (bloqueada por guard_derived_inventory_stock).

create table if not exists public.inventory_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.productos(id) on delete restrict,
  variant_id bigint not null references public.producto_variantes(id) on delete restrict,
  adjustment_date date not null default current_date,
  quantity_delta integer not null check (quantity_delta <> 0),
  reason text not null check (length(btrim(reason)) between 3 and 300),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  idempotency_key text unique
);

create index if not exists inventory_stock_adjustments_variant_idx
  on public.inventory_stock_adjustments(variant_id, adjustment_date desc);

alter table public.inventory_stock_adjustments enable row level security;
revoke all on public.inventory_stock_adjustments from public, anon, authenticated;
grant select, insert on public.inventory_stock_adjustments to service_role;

alter table public.inventory_operation_log
  drop constraint if exists inventory_operation_log_movement_type_check;
alter table public.inventory_operation_log
  add constraint inventory_operation_log_movement_type_check check (movement_type in (
    'purchase', 'web_sale', 'mercadolibre_sale', 'external_sale',
    'return', 'reclassification', 'write_off', 'repair', 'adjustment'
  ));

-- Se repite la vista completa (union all) porque CREATE OR REPLACE VIEW
-- exige la misma lista de columnas; sólo se agrega el último bloque.
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

-- 'Producto dañado/perdido' (agregada en Compras > Gastos para bajas sin
-- venta) nunca pudo guardarse: el CHECK sólo permitía Donación/Regalo y
-- Sorteo/Evento. Bug real, no sólo una omisión de UI.
alter table public.business_expenses
  drop constraint if exists business_expenses_product_fields_check;
alter table public.business_expenses
  add constraint business_expenses_product_fields_check check (
    (
      expense_type = 'money'
      and product_id is null
      and variant_id is null
      and quantity is null
    )
    or
    (
      expense_type = 'product'
      and product_name is not null
      and quantity is not null
      and quantity > 0
      and amount = 0
      and category in ('Donación/Regalo', 'Sorteo/Evento', 'Producto dañado/perdido')
    )
  );

create or replace function public.adjust_variant_stock_idempotent(
  p_variant_id bigint,
  p_new_quantity integer,
  p_reason text,
  p_actor_id uuid,
  p_idempotency_key text
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_delta integer;
begin
  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'La cantidad no puede ser negativa.';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Indicá un motivo para el ajuste.';
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory-stock-adjustment'), hashtext(v_key));

  if exists (
    select 1 from public.inventory_operation_log log
    where log.idempotency_key = v_key
  ) then
    select * into v_variant
    from public.producto_variantes
    where id = p_variant_id;
    if not found then
      raise exception 'La variante ya no existe.';
    end if;
    return v_variant;
  end if;

  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id
  for update;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  perform pg_advisory_xact_lock(93000, v_variant.producto_id::integer);

  v_delta := p_new_quantity - coalesce(v_variant.stock, 0);
  if v_delta = 0 then
    return v_variant;
  end if;

  insert into public.inventory_stock_adjustments (
    product_id, variant_id, quantity_delta, reason, created_by, idempotency_key
  ) values (
    v_variant.producto_id, p_variant_id, v_delta, v_reason, p_actor_id, v_key
  );

  perform public.refresh_inventory_stock(v_variant.producto_id);

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  ) values (
    v_variant.producto_id, p_variant_id, 'adjustment', abs(v_delta),
    'admin_stock_adjustment', now(), p_actor_id,
    'adjust_variant_stock_idempotent', v_key, 'inventory_stock_adjustments',
    v_key, v_reason,
    jsonb_build_object(
      'previousStock', coalesce(v_variant.stock, 0),
      'newStock', p_new_quantity,
      'delta', v_delta
    )
  ) on conflict (idempotency_key) do nothing;

  select * into v_variant
  from public.producto_variantes
  where id = p_variant_id;
  return v_variant;
end;
$$;

revoke all on function public.adjust_variant_stock_idempotent(bigint, integer, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.adjust_variant_stock_idempotent(bigint, integer, text, uuid, text)
  to service_role;

comment on function public.adjust_variant_stock_idempotent(bigint, integer, text, uuid, text) is
  'Corrección manual de la cantidad de stock de una variante (recuento físico, unidades falladas), registrada como un movimiento más de inventory_movements con motivo obligatorio.';
