-- Fuente única e idempotencia para inventario.
-- El stock almacenado es una proyección de inventory_movements; nunca un saldo
-- independiente. Esta migración corrige la doble representación detectada al
-- vincular una devolución histórica a una variante creada posteriormente.

create table if not exists public.inventory_operation_log (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.productos(id) on delete restrict,
  variant_id bigint references public.producto_variantes(id) on delete restrict,
  movement_type text not null check (movement_type in (
    'purchase', 'web_sale', 'mercadolibre_sale', 'external_sale',
    'return', 'reclassification', 'write_off', 'repair'
  )),
  quantity integer not null check (quantity > 0),
  origin text not null check (length(btrim(origin)) between 2 and 80),
  effective_at timestamptz not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_process text not null check (length(btrim(actor_process)) between 2 and 120),
  idempotency_key text not null unique check (
    length(btrim(idempotency_key)) between 8 and 240
  ),
  source_table text not null check (length(btrim(source_table)) between 2 and 120),
  source_id text not null check (length(btrim(source_id)) between 1 and 240),
  document_reference text not null check (
    length(btrim(document_reference)) between 1 and 300
  ),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists inventory_operation_log_product_idx
  on public.inventory_operation_log(product_id, variant_id, effective_at desc);
create unique index if not exists inventory_operation_log_source_unique
  on public.inventory_operation_log(source_table, source_id, movement_type, idempotency_key);

alter table public.inventory_operation_log enable row level security;
revoke all on public.inventory_operation_log from public, anon, authenticated;
grant select, insert on public.inventory_operation_log to service_role;

create or replace function public.prevent_inventory_operation_log_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'El historial de operaciones de inventario es inmutable.';
end;
$$;

drop trigger if exists prevent_inventory_operation_log_mutation
  on public.inventory_operation_log;
create trigger prevent_inventory_operation_log_mutation
before update or delete on public.inventory_operation_log
for each row execute function public.prevent_inventory_operation_log_mutation();

-- Las compras nuevas reciben una clave estable desde la API. Las ediciones
-- siguen identificadas por el UUID del documento y establecen cantidades
-- absolutas, por lo que no reaplican deltas.
alter table public.product_cost_entries
  add column if not exists idempotency_key text;
create unique index if not exists product_cost_entries_idempotency_unique
  on public.product_cost_entries(idempotency_key)
  where idempotency_key is not null;

create or replace function public.save_product_purchase_idempotent(
  p_purchase jsonb,
  p_actor_id uuid,
  p_idempotency_key text
)
returns public.product_cost_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.product_cost_entries%rowtype;
  v_saved public.product_cost_entries%rowtype;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory-purchase'), hashtext(v_key));

  select * into v_existing
  from public.product_cost_entries entries
  where entries.idempotency_key = v_key
  for update;
  if found then
    return v_existing;
  end if;

  v_saved := public.save_product_purchase_atomic(p_purchase, p_actor_id);
  update public.product_cost_entries
  set idempotency_key = v_key
  where id = v_saved.id
  returning * into v_saved;

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  )
  select
    v_saved.product_id,
    v_saved.variant_id,
    'purchase',
    v_saved.received_quantity,
    'admin_purchase',
    v_saved.purchase_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
    p_actor_id,
    'save_product_purchase_idempotent',
    v_key,
    'product_cost_entries',
    v_saved.id::text,
    coalesce(nullif(btrim(v_saved.document_number), ''), v_saved.id::text),
    jsonb_build_object('receptionStatus', v_saved.reception_status)
  where v_saved.product_id is not null
    and v_saved.received_quantity > 0
  on conflict (idempotency_key) do nothing;

  return v_saved;
end;
$$;

revoke all on function public.save_product_purchase_idempotent(jsonb, uuid, text)
  from public, anon, authenticated;
grant execute on function public.save_product_purchase_idempotent(jsonb, uuid, text)
  to service_role;

-- Una sesión de carrito sólo puede originar una orden. Un reintento puede
-- recibir conflicto, pero nunca crear un segundo documento ni descontar stock.
alter table public.ordenes
  add column if not exists checkout_idempotency_key text;
create unique index if not exists ordenes_checkout_idempotency_unique
  on public.ordenes(checkout_idempotency_key)
  where checkout_idempotency_key is not null;

alter table public.business_expenses
  add column if not exists idempotency_key text;
create unique index if not exists business_expenses_idempotency_unique
  on public.business_expenses(idempotency_key)
  where idempotency_key is not null;

-- Proyección canónica: cada fila conserva el documento fuente y una identidad
-- estable. Los primeros siete campos mantienen el contrato histórico.
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
  and expenses.quantity is not null;

grant select on public.inventory_movements to authenticated, service_role;

create or replace function public.create_product_business_expense_idempotent(
  p_expense_date date,
  p_category text,
  p_recipient text,
  p_category_detail text,
  p_description text,
  p_product_id bigint,
  p_variant_id bigint,
  p_product_name text,
  p_product_sku text,
  p_quantity integer,
  p_notes text,
  p_created_by uuid,
  p_idempotency_key text
)
returns public.business_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.business_expenses%rowtype;
  v_saved public.business_expenses%rowtype;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if v_key is null or length(v_key) < 8 or length(v_key) > 240 then
    raise exception 'IDEMPOTENCY_KEY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtext('inventory-expense'), hashtext(v_key));

  select * into v_existing
  from public.business_expenses expenses
  where expenses.idempotency_key = v_key
  for update;
  if found then return v_existing; end if;

  v_saved := public.create_product_business_expense(
    p_expense_date, p_category, p_recipient, p_category_detail,
    p_description, p_product_id, p_variant_id, p_product_name,
    p_product_sku, p_quantity, p_notes, p_created_by
  );

  update public.business_expenses
  set idempotency_key = v_key
  where id = v_saved.id
  returning * into v_saved;

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  ) values (
    p_product_id, p_variant_id, 'write_off', p_quantity,
    'product_business_expense',
    p_expense_date::timestamp at time zone 'America/Argentina/Buenos_Aires',
    p_created_by, 'create_product_business_expense_idempotent', v_key,
    'business_expenses', v_saved.id::text, v_saved.id::text,
    jsonb_build_object('category', p_category)
  ) on conflict (idempotency_key) do nothing;

  return v_saved;
end;
$$;

revoke all on function public.create_product_business_expense_idempotent(
  date, text, text, text, text, bigint, bigint, text, text,
  integer, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.create_product_business_expense_idempotent(
  date, text, text, text, text, bigint, bigint, text, text,
  integer, text, uuid, text
) to service_role;

-- variant_id modifica a qué sublibro pertenece una devolución normal. Sólo la
-- RPC atómica siguiente puede cambiarlo; editar la ficha condicionada ya no
-- puede mover stock silenciosamente.
create or replace function public.guard_inventory_return_variant_link()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.variant_id is distinct from old.variant_id
     and current_setting('beyonix.inventory_variant_link', true) is distinct from 'on' then
    raise exception 'INVENTORY_VARIANT_LINK_RPC_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_inventory_return_variant_link
  on public.inventory_return_movements;
create trigger guard_inventory_return_variant_link
before update of variant_id on public.inventory_return_movements
for each row execute function public.guard_inventory_return_variant_link();

create or replace function public.link_conditioned_stock_variant_idempotent(
  p_return_id uuid,
  p_variant_id bigint,
  p_actor_id uuid,
  p_idempotency_key text,
  p_document_reference text
)
returns public.inventory_return_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_return public.inventory_return_movements%rowtype;
  v_allocation public.inventory_variant_allocations%rowtype;
  v_generic_after bigint;
  v_total_allocated bigint;
  v_overflow bigint;
  v_reduction bigint;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_reference text := nullif(btrim(coalesce(p_document_reference, '')), '');
begin
  if p_return_id is null or p_variant_id is null or p_variant_id <= 0
     or v_key is null or length(v_key) < 8 or length(v_key) > 240
     or v_reference is null then
    raise exception 'Los datos de vinculación no son válidos.';
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory-return-link'), hashtext(v_key));

  select * into v_return
  from public.inventory_return_movements movements
  where movements.id = p_return_id
  for update;
  if not found then raise exception 'La devolución ya no existe.'; end if;

  perform pg_advisory_xact_lock(93000, v_return.product_id::integer);

  if not exists (
    select 1 from public.producto_variantes variants
    where variants.id = p_variant_id
      and variants.producto_id = v_return.product_id
  ) then
    raise exception 'La variante no pertenece al producto.';
  end if;

  if exists (
    select 1 from public.inventory_operation_log operations
    where operations.idempotency_key = v_key
  ) then
    if v_return.variant_id is distinct from p_variant_id then
      raise exception 'IDEMPOTENCY_KEY_CONFLICT';
    end if;
    return v_return;
  end if;

  if v_return.variant_id is not null
     and v_return.variant_id is distinct from p_variant_id then
    raise exception 'La devolución ya está vinculada a otra variante.';
  end if;

  if v_return.variant_id is null then
    perform set_config('beyonix.inventory_variant_link', 'on', true);
    update public.inventory_return_movements movements
    set variant_id = p_variant_id
    where movements.id = v_return.id
    returning * into v_return;

    select coalesce(sum(movements.quantity_delta), 0)::bigint
    into v_generic_after
    from public.inventory_movements movements
    where movements.product_id = v_return.product_id
      and movements.variant_id is null
      and movements.movement_date <= current_date;

    select coalesce(sum(allocations.quantity), 0)::bigint
    into v_total_allocated
    from public.inventory_variant_allocations allocations
    where allocations.product_id = v_return.product_id;

    v_overflow := greatest(v_total_allocated - greatest(v_generic_after, 0), 0);

    select * into v_allocation
    from public.inventory_variant_allocations allocations
    where allocations.product_id = v_return.product_id
      and allocations.variant_id = p_variant_id
    for update;

    v_reduction := least(
      v_return.sellable_quantity,
      v_overflow,
      coalesce(v_allocation.quantity, 0)
    );

    if v_reduction > 0 then
      update public.inventory_variant_allocations allocations
      set quantity = quantity - v_reduction,
          updated_by = p_actor_id,
          updated_at = now()
      where allocations.product_id = v_return.product_id
        and allocations.variant_id = p_variant_id;
    end if;
  else
    v_reduction := 0;
  end if;

  perform public.refresh_inventory_stock(v_return.product_id);

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  ) values (
    v_return.product_id,
    p_variant_id,
    'reclassification',
    greatest(v_return.received_quantity, 1),
    'conditioned_stock_variant_link',
    coalesce(v_return.occurred_at, v_return.approved_at, v_return.created_at),
    p_actor_id,
    'link_conditioned_stock_variant_idempotent',
    v_key,
    'inventory_return_movements',
    v_return.id::text,
    v_reference,
    jsonb_build_object(
      'physicalDelta', 0,
      'sellableQuantity', v_return.sellable_quantity,
      'discountedQuantity', v_return.discounted_quantity,
      'allocationReduction', coalesce(v_reduction, 0)
    )
  ) on conflict (idempotency_key) do nothing;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'inventory_variant_allocations',
    'UPDATE',
    v_return.product_id::text || ':' || p_variant_id::text,
    p_actor_id,
    jsonb_build_object('quantity', coalesce(v_allocation.quantity, 0)),
    jsonb_build_object(
      'quantity', greatest(coalesce(v_allocation.quantity, 0) - coalesce(v_reduction, 0), 0),
      'reason', 'conditioned_return_variant_link',
      'returnId', v_return.id
    )
  );

  return v_return;
end;
$$;

revoke all on function public.link_conditioned_stock_variant_idempotent(
  uuid, bigint, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.link_conditioned_stock_variant_idempotent(
  uuid, bigint, uuid, text, text
) to service_role;

-- Diagnóstico por variante. expected_stock elimina únicamente la parte de la
-- asignación que también está respaldada por una devolución normal histórica.
create or replace view public.inventory_variant_diagnostics
with (security_invoker = true)
as
select
  products.id as product_id,
  products.nombre as product_name,
  variants.id as variant_id,
  variants.nombre as variant_name,
  variants.sku as variant_sku,
  variants.stock::bigint as actual_stock,
  (
    coalesce(allocations.quantity, 0)
    + coalesce(variant_movements.balance, 0)
  )::bigint as calculated_stock,
  greatest(
    least(
      coalesce(allocations.quantity, 0),
      coalesce(historical_returns.quantity, 0),
      coalesce(integrity.allocation_overflow, 0)
    ),
    0
  )::bigint as duplicated_allocation,
  (
    coalesce(allocations.quantity, 0)
    + coalesce(variant_movements.balance, 0)
    - greatest(
        least(
          coalesce(allocations.quantity, 0),
          coalesce(historical_returns.quantity, 0),
          coalesce(integrity.allocation_overflow, 0)
        ),
        0
      )
  )::bigint as expected_stock,
  (
    variants.stock
    - (
        coalesce(allocations.quantity, 0)
        + coalesce(variant_movements.balance, 0)
        - greatest(
            least(
              coalesce(allocations.quantity, 0),
              coalesce(historical_returns.quantity, 0),
              coalesce(integrity.allocation_overflow, 0)
            ),
            0
          )
      )
  )::bigint as difference,
  coalesce(allocations.quantity, 0)::bigint as allocation_quantity,
  coalesce(integrity.generic_balance, 0)::bigint as generic_balance,
  coalesce(integrity.allocation_overflow, 0)::bigint as allocation_overflow,
  historical_returns.movement_id as possible_cause_movement_id,
  historical_returns.occurred_at as possible_cause_at,
  case
    when coalesce(integrity.allocation_overflow, 0) > 0
      and coalesce(historical_returns.quantity, 0) > 0
    then 'Devolución normal vinculada después de quedar incluida en la asignación inicial.'
    when coalesce(integrity.allocation_overflow, 0) > 0
    then 'La asignación por variante supera el saldo genérico disponible.'
    when variants.stock is distinct from (
      coalesce(allocations.quantity, 0) + coalesce(variant_movements.balance, 0)
    )
    then 'El stock almacenado no coincide con el libro derivado.'
    else null
  end as possible_cause,
  integrity.issues
from public.productos products
join public.producto_variantes variants on variants.producto_id = products.id
left join public.inventory_stock_integrity integrity
  on integrity.product_id = products.id
left join public.inventory_variant_allocations allocations
  on allocations.product_id = products.id
 and allocations.variant_id = variants.id
left join lateral (
  select coalesce(sum(movements.quantity_delta), 0)::bigint as balance
  from public.inventory_movements movements
  where movements.product_id = products.id
    and movements.variant_id = variants.id
    and movements.movement_date <= current_date
) variant_movements on true
left join lateral (
  select
    sum(returns.sellable_quantity)::bigint as quantity,
    (array_agg(returns.id order by coalesce(returns.occurred_at, returns.approved_at, returns.created_at) desc))[1]
      as movement_id,
    max(coalesce(returns.occurred_at, returns.approved_at, returns.created_at))
      as occurred_at
  from public.inventory_return_movements returns
  where returns.product_id = products.id
    and returns.variant_id = variants.id
    and returns.sellable_quantity > 0
    and coalesce(returns.approved_at, returns.created_at)
        <= coalesce(allocations.updated_at, variants.created_at)
) historical_returns on true;

revoke all on public.inventory_variant_diagnostics from public, anon;
grant select on public.inventory_variant_diagnostics to authenticated, service_role;

create or replace function public.repair_inventory_allocation_overflow(
  p_product_id bigint,
  p_variant_id bigint,
  p_confirm boolean,
  p_actor_id uuid,
  p_idempotency_key text,
  p_document_reference text
)
returns setof public.inventory_variant_diagnostics
language plpgsql
security definer
set search_path = public
as $$
declare
  v_diagnostic public.inventory_variant_diagnostics%rowtype;
  v_before public.inventory_variant_allocations%rowtype;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_reference text := nullif(btrim(coalesce(p_document_reference, '')), '');
begin
  if not coalesce(p_confirm, false) then
    raise exception 'REPAIR_CONFIRMATION_REQUIRED';
  end if;
  if v_key is null or length(v_key) < 8 or length(v_key) > 240
     or v_reference is null then
    raise exception 'Los datos de reparación no son válidos.';
  end if;

  perform pg_advisory_xact_lock(hashtext('inventory-repair'), hashtext(v_key));
  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  select * into v_diagnostic
  from public.inventory_variant_diagnostics diagnostics
  where diagnostics.product_id = p_product_id
    and diagnostics.variant_id = p_variant_id;
  if not found then raise exception 'No existe el diagnóstico solicitado.'; end if;

  if exists (
    select 1 from public.inventory_operation_log operations
    where operations.idempotency_key = v_key
  ) then
    return query
    select * from public.inventory_variant_diagnostics diagnostics
    where diagnostics.product_id = p_product_id
      and diagnostics.variant_id = p_variant_id;
    return;
  end if;

  if v_diagnostic.duplicated_allocation <= 0
     or v_diagnostic.possible_cause_movement_id is null then
    raise exception 'La diferencia no tiene un movimiento duplicado demostrable.';
  end if;

  select * into v_before
  from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id
    and allocations.variant_id = p_variant_id
  for update;
  if not found or v_before.quantity < v_diagnostic.duplicated_allocation then
    raise exception 'La asignación cambió; volvé a ejecutar el diagnóstico.';
  end if;

  update public.inventory_variant_allocations allocations
  set quantity = quantity - v_diagnostic.duplicated_allocation,
      updated_by = p_actor_id,
      updated_at = now()
  where allocations.product_id = p_product_id
    and allocations.variant_id = p_variant_id;

  perform public.refresh_inventory_stock(p_product_id);

  insert into public.inventory_operation_log (
    product_id, variant_id, movement_type, quantity, origin, effective_at,
    actor_user_id, actor_process, idempotency_key, source_table, source_id,
    document_reference, metadata
  ) values (
    p_product_id,
    p_variant_id,
    'repair',
    v_diagnostic.duplicated_allocation,
    'inventory_integrity_diagnostic',
    now(),
    p_actor_id,
    'repair_inventory_allocation_overflow',
    v_key,
    'inventory_return_movements',
    v_diagnostic.possible_cause_movement_id::text,
    v_reference,
    jsonb_build_object(
      'physicalDelta', 0,
      'allocationBefore', v_before.quantity,
      'allocationAfter', v_before.quantity - v_diagnostic.duplicated_allocation,
      'expectedStock', v_diagnostic.expected_stock,
      'actualStockBefore', v_diagnostic.actual_stock,
      'cause', v_diagnostic.possible_cause
    )
  );

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, before_data, after_data
  ) values (
    'inventory_variant_allocations',
    'UPDATE',
    p_product_id::text || ':' || p_variant_id::text,
    p_actor_id,
    to_jsonb(v_before),
    jsonb_build_object(
      'product_id', p_product_id,
      'variant_id', p_variant_id,
      'quantity', v_before.quantity - v_diagnostic.duplicated_allocation,
      'repairKey', v_key,
      'causeMovementId', v_diagnostic.possible_cause_movement_id
    )
  );

  return query
  select * from public.inventory_variant_diagnostics diagnostics
  where diagnostics.product_id = p_product_id
    and diagnostics.variant_id = p_variant_id;
end;
$$;

revoke all on function public.repair_inventory_allocation_overflow(
  bigint, bigint, boolean, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.repair_inventory_allocation_overflow(
  bigint, bigint, boolean, uuid, text, text
) to service_role;

-- Reparación quirúrgica del único caso comprobado. Todas las condiciones deben
-- seguir coincidiendo; de lo contrario no modifica datos.
do $$
declare
  v_matches integer;
begin
  select count(*) into v_matches
  from public.inventory_variant_diagnostics diagnostics
  where diagnostics.product_id = 62
    and diagnostics.variant_id = 44
    and diagnostics.duplicated_allocation = 1
    and diagnostics.possible_cause_movement_id =
      '93d50404-31ec-4ec0-9721-7daf96ca4e33'::uuid;

  if v_matches = 1 then
    perform public.repair_inventory_allocation_overflow(
      62,
      44,
      true,
      null,
      'repair:allocation-overflow:return:93d50404-31ec-4ec0-9721-7daf96ca4e33',
      'Migración 20260801104000: doble representación de devolución y asignación'
    );
  end if;
end;
$$;

comment on table public.inventory_operation_log is
  'Historial inmutable de operaciones e idempotencia; no reemplaza los documentos fuente.';
comment on view public.inventory_variant_diagnostics is
  'Compara stock esperado y actual e identifica devoluciones incluidas dos veces en asignaciones.';
