-- Fuente única de inventario:
-- saldo inicial conciliado + compras recibidas - ventas confirmadas
-- + devoluciones aprobadas reingresadas - salidas internas.
-- MIGRACIÓN HISTÓRICA: no volver a ejecutarla si ya existen
-- public.inventory_movements o public.inventory_stock_timeline (migración 095).
-- Para actualizar únicamente la descripción visible, usar
-- 100_inventory_stock_wording.sql.

do $$
begin
  if to_regclass('public.inventory_variant_allocations') is not null then
    raise exception
      'La migración 093 es histórica y no debe volver a ejecutarse. Aplicá 101_restore_variant_inventory_calculation.sql.';
  end if;
end;
$$;

alter table public.product_cost_entries
  add column if not exists received_quantity integer;

update public.product_cost_entries
set received_quantity = quantity
where received_quantity is null;

alter table public.product_cost_entries
  alter column received_quantity set not null,
  alter column received_quantity set default 0,
  drop constraint if exists product_cost_entries_received_quantity_check,
  add constraint product_cost_entries_received_quantity_check
    check (received_quantity >= 0 and received_quantity <= quantity);

create table if not exists public.inventory_opening_balances (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.productos(id) on delete cascade,
  variant_id bigint references public.producto_variantes(id) on delete cascade,
  quantity integer not null,
  reason text not null default 'Conciliación de inventario anterior',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists inventory_opening_balance_product_variant_uidx
  on public.inventory_opening_balances (
    product_id,
    coalesce(variant_id, 0)
  );

alter table public.inventory_opening_balances enable row level security;
revoke all on table public.inventory_opening_balances from anon, authenticated;
grant select on table public.inventory_opening_balances to authenticated;
drop policy if exists "Admins read inventory opening balances"
  on public.inventory_opening_balances;
create policy "Admins read inventory opening balances"
on public.inventory_opening_balances
for select to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

create table if not exists public.inventory_return_movements (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  order_id bigint not null references public.ordenes(id) on delete restrict,
  order_item_id bigint not null references public.orden_items(id) on delete restrict,
  product_id bigint not null references public.productos(id) on delete restrict,
  variant_id bigint references public.producto_variantes(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists inventory_return_movements_product_idx
  on public.inventory_return_movements(product_id, variant_id, approved_at);

alter table public.inventory_return_movements enable row level security;
revoke all on table public.inventory_return_movements from anon, authenticated;
grant select on table public.inventory_return_movements to authenticated;
drop policy if exists "Admins read inventory return movements"
  on public.inventory_return_movements;
create policy "Admins read inventory return movements"
on public.inventory_return_movements
for select to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

insert into public.inventory_return_movements (
  source_key,
  order_id,
  order_item_id,
  product_id,
  variant_id,
  quantity,
  approved_by,
  approved_at
)
select
  'legacy-order-item:' || items.id,
  items.orden_id,
  items.id,
  items.producto_id,
  items.variante_id,
  items.return_restocked_quantity,
  items.return_inventory_processed_by,
  items.return_inventory_processed_at
from public.orden_items items
where items.return_inventory_processed_at is not null
  and items.return_restocked_quantity > 0
on conflict (source_key) do nothing;

create or replace function public.inventory_order_consumes_stock(
  p_status text,
  p_payment_status text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select
    coalesce(p_status, '') in (
      'pagado',
      'preparado',
      'enviado',
      'en_camino',
      'visita_fallida',
      'en_sucursal',
      'retiro_pendiente',
      'retiro_vencido',
      'en_devolucion',
      'devuelto_beyonix',
      'entregado',
      'approved'
    )
    or (
      coalesce(p_status, '') <> 'cancelado'
      and coalesce(p_payment_status, '') in (
        'confirmado',
        'confirmed',
        'approved'
      )
    );
$$;

-- La conciliación inicial resta los movimientos que pasarán a formar parte
-- del cálculo y revierte las reservas históricas hechas al crear pedidos,
-- incluso cuando esos pedidos nunca llegaron a confirmarse.
insert into public.inventory_opening_balances (
  product_id,
  variant_id,
  quantity,
  reason
)
select
  variants.producto_id,
  variants.id,
  coalesce(variants.stock, 0)
    - coalesce(purchases.quantity, 0)
    + coalesce(all_orders.quantity, 0)
    - coalesce(returns.quantity, 0)
    + coalesce(expenses.quantity, 0),
  'Conciliación automática al unificar Compras, Pedidos y Productos'
from public.producto_variantes variants
left join lateral (
  select sum(entries.received_quantity)::integer as quantity
  from public.product_cost_entries entries
  where entries.product_id = variants.producto_id
    and entries.variant_id = variants.id
) purchases on true
left join lateral (
  select sum(items.cantidad)::integer as quantity
  from public.orden_items items
  where items.producto_id = variants.producto_id
    and items.variante_id = variants.id
) all_orders on true
left join lateral (
  select sum(movements.quantity)::integer as quantity
  from public.inventory_return_movements movements
  where movements.product_id = variants.producto_id
    and movements.variant_id = variants.id
) returns on true
left join lateral (
  select sum(costs.quantity)::integer as quantity
  from public.business_expenses costs
  where costs.expense_type = 'product'
    and costs.product_id = variants.producto_id
    and costs.variant_id = variants.id
) expenses on true
on conflict do nothing;

insert into public.inventory_opening_balances (
  product_id,
  variant_id,
  quantity,
  reason
)
select
  products.id,
  null,
  coalesce(products.stock, 0)
    - coalesce(purchases.quantity, 0)
    + coalesce(all_orders.quantity, 0)
    - coalesce(returns.quantity, 0)
    + coalesce(expenses.quantity, 0),
  'Conciliación automática al unificar Compras, Pedidos y Productos'
from public.productos products
left join lateral (
  select sum(entries.received_quantity)::integer as quantity
  from public.product_cost_entries entries
  where entries.product_id = products.id
    and entries.variant_id is null
) purchases on true
left join lateral (
  select sum(items.cantidad)::integer as quantity
  from public.orden_items items
  where items.producto_id = products.id
    and items.variante_id is null
) all_orders on true
left join lateral (
  select sum(movements.quantity)::integer as quantity
  from public.inventory_return_movements movements
  where movements.product_id = products.id
    and movements.variant_id is null
) returns on true
left join lateral (
  select sum(costs.quantity)::integer as quantity
  from public.business_expenses costs
  where costs.expense_type = 'product'
    and costs.product_id = products.id
    and costs.variant_id is null
) expenses on true
where not exists (
  select 1
  from public.producto_variantes variants
  where variants.producto_id = products.id
)
on conflict do nothing;

create or replace function public.refresh_inventory_stock(
  p_product_id bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_previous_refresh_setting text := coalesce(
    current_setting('beyonix.inventory_refresh', true),
    ''
  );
begin
  if p_product_id is null then
    return;
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  perform set_config('beyonix.inventory_refresh', 'on', true);

  update public.producto_variantes variants
  set stock =
    coalesce((
      select sum(opening.quantity)
      from public.inventory_opening_balances opening
      where opening.product_id = variants.producto_id
        and opening.variant_id = variants.id
    ), 0)
    + coalesce((
      select sum(entries.received_quantity)
      from public.product_cost_entries entries
      where entries.product_id = variants.producto_id
        and entries.variant_id = variants.id
    ), 0)
    - coalesce((
      select sum(items.cantidad)
      from public.orden_items items
      join public.ordenes orders on orders.id = items.orden_id
      where items.producto_id = variants.producto_id
        and items.variante_id = variants.id
        and public.inventory_order_consumes_stock(
          orders.estado,
          orders.payment_status
        )
    ), 0)
    + coalesce((
      select sum(items.quantity)
      from public.inventory_return_movements items
      where items.product_id = variants.producto_id
        and items.variant_id = variants.id
    ), 0)
    - coalesce((
      select sum(costs.quantity)
      from public.business_expenses costs
      where costs.expense_type = 'product'
        and costs.product_id = variants.producto_id
        and costs.variant_id = variants.id
    ), 0)
  where variants.producto_id = p_product_id;

  if exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = p_product_id
  ) then
    update public.productos products
    set stock = coalesce((
      select sum(variants.stock)
      from public.producto_variantes variants
      where variants.producto_id = products.id
    ), 0)
    where products.id = p_product_id;
  else
    update public.productos products
    set stock =
      coalesce((
        select sum(opening.quantity)
        from public.inventory_opening_balances opening
        where opening.product_id = products.id
          and opening.variant_id is null
      ), 0)
      + coalesce((
        select sum(entries.received_quantity)
        from public.product_cost_entries entries
        where entries.product_id = products.id
          and entries.variant_id is null
      ), 0)
      - coalesce((
        select sum(items.cantidad)
        from public.orden_items items
        join public.ordenes orders on orders.id = items.orden_id
        where items.producto_id = products.id
          and items.variante_id is null
          and public.inventory_order_consumes_stock(
            orders.estado,
            orders.payment_status
          )
      ), 0)
      + coalesce((
        select sum(items.quantity)
        from public.inventory_return_movements items
        where items.product_id = products.id
          and items.variant_id is null
      ), 0)
      - coalesce((
        select sum(costs.quantity)
        from public.business_expenses costs
        where costs.expense_type = 'product'
          and costs.product_id = products.id
          and costs.variant_id is null
      ), 0)
    where products.id = p_product_id;
  end if;

  perform set_config(
    'beyonix.inventory_refresh',
    v_previous_refresh_setting,
    true
  );
end;
$$;

revoke all on function public.refresh_inventory_stock(bigint)
  from public, anon, authenticated;
grant execute on function public.refresh_inventory_stock(bigint)
  to service_role;

create or replace function public.guard_derived_inventory_stock()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.stock := 0;
    return new;
  end if;

  if new.stock is distinct from old.stock
     and coalesce(
       current_setting('beyonix.inventory_refresh', true),
       ''
     ) <> 'on' then
    raise exception
      'INVENTORY_STOCK_IS_DERIVED: registrá una compra, venta, devolución o salida.';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_derived_product_stock on public.productos;
create trigger guard_derived_product_stock
before insert or update of stock on public.productos
for each row execute function public.guard_derived_inventory_stock();

drop trigger if exists guard_derived_variant_stock on public.producto_variantes;
create trigger guard_derived_variant_stock
before insert or update of stock on public.producto_variantes
for each row execute function public.guard_derived_inventory_stock();

create or replace function public.refresh_inventory_from_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_product_id bigint;
  v_new_product_id bigint;
begin
  v_old_product_id := case when tg_op <> 'INSERT' then old.product_id else null end;
  v_new_product_id := case when tg_op <> 'DELETE' then new.product_id else null end;

  if v_old_product_id is not null then
    perform public.refresh_inventory_stock(v_old_product_id);
  end if;
  if v_new_product_id is not null
     and v_new_product_id is distinct from v_old_product_id then
    perform public.refresh_inventory_stock(v_new_product_id);
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists refresh_inventory_after_purchase
  on public.product_cost_entries;
create trigger refresh_inventory_after_purchase
after insert or update or delete on public.product_cost_entries
for each row execute function public.refresh_inventory_from_row();

drop trigger if exists refresh_inventory_after_return_movement
  on public.inventory_return_movements;
create trigger refresh_inventory_after_return_movement
after insert or update or delete on public.inventory_return_movements
for each row execute function public.refresh_inventory_from_row();

create or replace function public.refresh_inventory_from_variant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_product_id bigint;
  v_new_product_id bigint;
begin
  v_old_product_id := case when tg_op <> 'INSERT' then old.producto_id else null end;
  v_new_product_id := case when tg_op <> 'DELETE' then new.producto_id else null end;

  if v_old_product_id is not null then
    perform public.refresh_inventory_stock(v_old_product_id);
  end if;
  if v_new_product_id is not null
     and v_new_product_id is distinct from v_old_product_id then
    perform public.refresh_inventory_stock(v_new_product_id);
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists refresh_inventory_after_variant
  on public.producto_variantes;
create trigger refresh_inventory_after_variant
after insert or delete or update of producto_id on public.producto_variantes
for each row execute function public.refresh_inventory_from_variant();

drop trigger if exists refresh_inventory_after_expense
  on public.business_expenses;
create trigger refresh_inventory_after_expense
after insert or update or delete on public.business_expenses
for each row execute function public.refresh_inventory_from_row();

create or replace function public.validate_inventory_order_item()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_order public.ordenes;
  v_available integer;
  v_previous_quantity integer := 0;
begin
  select *
  into v_order
  from public.ordenes
  where id = new.orden_id;

  if not found
     or not public.inventory_order_consumes_stock(
       v_order.estado,
       v_order.payment_status
     ) then
    return new;
  end if;

  perform pg_advisory_xact_lock(93000, new.producto_id::integer);

  if tg_op = 'UPDATE'
     and old.producto_id = new.producto_id
     and old.variante_id is not distinct from new.variante_id then
    v_previous_quantity := old.cantidad;
  end if;

  if new.variante_id is not null then
    select coalesce(variants.stock, 0)
    into v_available
    from public.producto_variantes variants
    where variants.id = new.variante_id
      and variants.producto_id = new.producto_id;
  else
    select coalesce(products.stock, 0)
    into v_available
    from public.productos products
    where products.id = new.producto_id;
  end if;

  if not found or v_available + v_previous_quantity < new.cantidad then
    raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_inventory_order_item on public.orden_items;
create trigger validate_inventory_order_item
before insert or update of producto_id, variante_id, cantidad
on public.orden_items
for each row execute function public.validate_inventory_order_item();

create or replace function public.refresh_inventory_from_order_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_product_id bigint;
  v_new_product_id bigint;
begin
  v_old_product_id := case when tg_op <> 'INSERT' then old.producto_id else null end;
  v_new_product_id := case when tg_op <> 'DELETE' then new.producto_id else null end;

  if v_old_product_id is not null then
    perform public.refresh_inventory_stock(v_old_product_id);
  end if;
  if v_new_product_id is not null
     and v_new_product_id is distinct from v_old_product_id then
    perform public.refresh_inventory_stock(v_new_product_id);
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists refresh_inventory_after_order_item on public.orden_items;
create trigger refresh_inventory_after_order_item
after insert or update or delete on public.orden_items
for each row execute function public.refresh_inventory_from_order_item();

create or replace function public.validate_inventory_order_confirmation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_item record;
  v_available integer;
begin
  if public.inventory_order_consumes_stock(old.estado, old.payment_status)
     or not public.inventory_order_consumes_stock(new.estado, new.payment_status) then
    return new;
  end if;

  for v_item in
    select
      items.producto_id,
      items.variante_id,
      sum(items.cantidad)::integer as quantity
    from public.orden_items items
    where items.orden_id = new.id
    group by items.producto_id, items.variante_id
    order by items.producto_id, items.variante_id nulls first
  loop
    perform pg_advisory_xact_lock(93000, v_item.producto_id::integer);

    if v_item.variante_id is not null then
      select coalesce(variants.stock, 0)
      into v_available
      from public.producto_variantes variants
      where variants.id = v_item.variante_id
        and variants.producto_id = v_item.producto_id;
    else
      select coalesce(products.stock, 0)
      into v_available
      from public.productos products
      where products.id = v_item.producto_id;
    end if;

    if not found or v_available < v_item.quantity then
      raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists validate_inventory_order_confirmation on public.ordenes;
create trigger validate_inventory_order_confirmation
before update of estado, payment_status on public.ordenes
for each row execute function public.validate_inventory_order_confirmation();

create or replace function public.refresh_inventory_from_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id bigint;
begin
  if public.inventory_order_consumes_stock(old.estado, old.payment_status)
     is not distinct from
     public.inventory_order_consumes_stock(new.estado, new.payment_status) then
    return new;
  end if;

  for v_product_id in
    select distinct items.producto_id
    from public.orden_items items
    where items.orden_id = new.id
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;

  return new;
end;
$$;

drop trigger if exists refresh_inventory_after_order on public.ordenes;
create trigger refresh_inventory_after_order
after update of estado, payment_status on public.ordenes
for each row execute function public.refresh_inventory_from_order();

create or replace view public.inventory_stock_breakdown
with (security_invoker = true)
as
select
  products.id as product_id,
  variants.id as variant_id,
  coalesce(opening.quantity, 0)::bigint as opening_quantity,
  coalesce(purchases.quantity, 0)::bigint as received_quantity,
  coalesce(sales.quantity, 0)::bigint as sold_quantity,
  coalesce(returns.quantity, 0)::bigint as restocked_quantity,
  coalesce(expenses.quantity, 0)::bigint as outgoing_quantity,
  case
    when variants.id is not null then coalesce(variants.stock, 0)
    else coalesce(products.stock, 0)
  end::bigint as available_quantity
from public.productos products
left join public.producto_variantes variants
  on variants.producto_id = products.id
left join lateral (
  select sum(balance.quantity) as quantity
  from public.inventory_opening_balances balance
  where balance.product_id = products.id
    and balance.variant_id is not distinct from variants.id
) opening on true
left join lateral (
  select sum(entries.received_quantity) as quantity
  from public.product_cost_entries entries
  where entries.product_id = products.id
    and entries.variant_id is not distinct from variants.id
) purchases on true
left join lateral (
  select sum(items.cantidad) as quantity
  from public.orden_items items
  join public.ordenes orders on orders.id = items.orden_id
  where items.producto_id = products.id
    and items.variante_id is not distinct from variants.id
    and public.inventory_order_consumes_stock(
      orders.estado,
      orders.payment_status
    )
) sales on true
left join lateral (
  select sum(movements.quantity) as quantity
  from public.inventory_return_movements movements
  where movements.product_id = products.id
    and movements.variant_id is not distinct from variants.id
) returns on true
left join lateral (
  select sum(costs.quantity) as quantity
  from public.business_expenses costs
  where costs.expense_type = 'product'
    and costs.product_id = products.id
    and costs.variant_id is not distinct from variants.id
) expenses on true;

grant select on public.inventory_stock_breakdown to authenticated;

-- Compatibilidad con los endpoints existentes: la operación deja de mutar
-- columnas y pasa a validar exclusivamente la proyección derivada.
create or replace function public.decrement_checkout_inventory(
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_available integer;
  v_variant_product_id bigint;
  v_active boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para validar el inventario del checkout.';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'CHECKOUT_ITEMS_INVALID';
  end if;

  for v_item in
    select
      item.product_id,
      item.variant_id,
      sum(item.quantity)::integer as quantity
    from jsonb_to_recordset(p_items) as item(
      product_id bigint,
      variant_id bigint,
      quantity integer
    )
    group by item.product_id, item.variant_id
    order by item.product_id, item.variant_id nulls first
  loop
    if v_item.product_id is null
       or v_item.product_id <= 0
       or v_item.quantity is null
       or v_item.quantity <= 0 then
      raise exception 'CHECKOUT_ITEMS_INVALID';
    end if;

    perform pg_advisory_xact_lock(93000, v_item.product_id::integer);

    if v_item.variant_id is not null then
      select
        variants.producto_id,
        coalesce(variants.stock, 0),
        coalesce(variants.activo, false)
      into v_variant_product_id, v_available, v_active
      from public.producto_variantes variants
      where variants.id = v_item.variant_id;

      if not found
         or v_variant_product_id <> v_item.product_id
         or not v_active
         or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    else
      select coalesce(products.stock, 0), coalesce(products.activo, false)
      into v_available, v_active
      from public.productos products
      where products.id = v_item.product_id;

      if not found or not v_active or v_available < v_item.quantity then
        raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
      end if;
    end if;
  end loop;

  return jsonb_build_object('validated', true, 'derived', true);
end;
$$;

create or replace function public.process_order_item_return_inventory(
  p_order_id bigint,
  p_order_item_id bigint,
  p_restocked_quantity integer,
  p_written_off_quantity integer,
  p_note text,
  p_processed_by uuid
)
returns public.orden_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.orden_items%rowtype;
begin
  if p_restocked_quantity < 0 or p_written_off_quantity < 0 then
    raise exception 'Las cantidades de la devolución no pueden ser negativas.';
  end if;
  if p_written_off_quantity > 0
     and length(trim(coalesce(p_note, ''))) < 3 then
    raise exception 'Indicá el motivo de la baja o pérdida.';
  end if;

  select *
  into v_item
  from public.orden_items
  where id = p_order_item_id
    and orden_id = p_order_id
  for update;

  if not found then
    raise exception 'No se encontró el producto dentro del pedido.';
  end if;
  if v_item.return_inventory_processed_at is not null then
    raise exception 'La recepción de este producto ya fue registrada.';
  end if;
  if p_restocked_quantity + p_written_off_quantity > v_item.cantidad then
    raise exception 'La cantidad recibida no puede superar la cantidad vendida.';
  end if;

  update public.orden_items
  set return_restocked_quantity = p_restocked_quantity,
      return_written_off_quantity = p_written_off_quantity,
      return_inventory_note = nullif(left(trim(coalesce(p_note, '')), 1000), ''),
      return_inventory_processed_at = now(),
      return_inventory_processed_by = p_processed_by
  where id = v_item.id
  returning * into v_item;

  if p_restocked_quantity > 0 then
    insert into public.inventory_return_movements (
      source_key,
      order_id,
      order_item_id,
      product_id,
      variant_id,
      quantity,
      approved_by,
      approved_at
    )
    values (
      'order-item:' || v_item.id,
      v_item.orden_id,
      v_item.id,
      v_item.producto_id,
      v_item.variante_id,
      p_restocked_quantity,
      p_processed_by,
      v_item.return_inventory_processed_at
    )
    on conflict (source_key) do nothing;
  end if;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    metadata
  )
  values (
    p_order_id,
    'admin',
    p_processed_by,
    'return_inventory_processed',
    jsonb_build_object(
      'orderItemId', v_item.id,
      'productId', v_item.producto_id,
      'variantId', v_item.variante_id,
      'restockedQuantity', p_restocked_quantity,
      'writtenOffQuantity', p_written_off_quantity,
      'sourceOfTruth', 'derived_inventory'
    )
  );

  return v_item;
end;
$$;

create or replace function public.create_product_business_expense(
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
  p_created_by uuid
)
returns public.business_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense public.business_expenses;
  v_available integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para registrar salidas de inventario.';
  end if;
  if p_category not in ('Donación/Regalo', 'Sorteo/Evento')
     or p_product_id is null
     or p_quantity is null
     or p_quantity <= 0
     or trim(coalesce(p_product_name, '')) = '' then
    raise exception 'PRODUCT_EXPENSE_INVALID';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  if exists (
    select 1 from public.producto_variantes
    where producto_id = p_product_id
  ) and p_variant_id is null then
    raise exception 'PRODUCT_EXPENSE_VARIANT_REQUIRED';
  end if;

  if p_variant_id is not null then
    select coalesce(stock, 0)
    into v_available
    from public.producto_variantes
    where id = p_variant_id
      and producto_id = p_product_id;
  else
    select coalesce(stock, 0)
    into v_available
    from public.productos
    where id = p_product_id;
  end if;

  if not found or v_available < p_quantity then
    raise exception 'PRODUCT_EXPENSE_STOCK_INSUFFICIENT';
  end if;

  insert into public.business_expenses (
    expense_date,
    category,
    category_detail,
    recipient,
    description,
    amount,
    recurrence,
    status,
    tax_deductible,
    notes,
    expense_type,
    product_id,
    variant_id,
    product_name,
    product_sku,
    quantity,
    created_by
  )
  values (
    p_expense_date,
    p_category,
    nullif(trim(p_category_detail), ''),
    nullif(trim(p_recipient), ''),
    nullif(trim(p_description), ''),
    0,
    'unico',
    'pagado',
    false,
    nullif(trim(p_notes), ''),
    'product',
    p_product_id,
    p_variant_id,
    trim(p_product_name),
    nullif(trim(p_product_sku), ''),
    p_quantity,
    p_created_by
  )
  returning * into v_expense;

  return v_expense;
end;
$$;

create or replace function public.delete_business_expense_with_inventory(
  p_expense_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para eliminar gastos.';
  end if;

  delete from public.business_expenses
  where id = p_expense_id;

  return found;
end;
$$;

do $$
declare
  v_product_id bigint;
begin
  for v_product_id in select id from public.productos order by id
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;
end;
$$;

comment on column public.productos.stock is
  'Proyección derivada del libro unificado de inventario. No se edita manualmente.';
comment on column public.producto_variantes.stock is
  'Proyección derivada del libro unificado de inventario. No se edita manualmente.';
comment on view public.inventory_stock_breakdown is
  'Explica el stock por producto y variante usando compras, ventas, devoluciones y salidas.';
