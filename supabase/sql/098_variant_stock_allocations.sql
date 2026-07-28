-- Distribución del stock genérico comprado entre variantes comerciales.
-- La asignación no crea ni elimina unidades: solamente clasifica por variante.

create table if not exists public.inventory_variant_allocations (
  product_id bigint not null
    references public.productos(id) on delete cascade,
  variant_id bigint primary key
    references public.producto_variantes(id) on delete cascade,
  quantity integer not null default 0 check (quantity >= 0),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (product_id, variant_id)
);

create index if not exists inventory_variant_allocations_product_idx
  on public.inventory_variant_allocations(product_id);

alter table public.inventory_variant_allocations enable row level security;
revoke all on table public.inventory_variant_allocations from anon, authenticated;
grant select on table public.inventory_variant_allocations to authenticated;

drop policy if exists "Admins read variant allocations"
  on public.inventory_variant_allocations;
create policy "Admins read variant allocations"
on public.inventory_variant_allocations
for select to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

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
      select sum(movements.quantity_delta)
      from public.inventory_movements movements
      where movements.product_id = variants.producto_id
        and movements.variant_id = variants.id
        and movements.movement_date <= current_date
    ), 0)
    + coalesce((
      select allocations.quantity
      from public.inventory_variant_allocations allocations
      where allocations.variant_id = variants.id
    ), 0)
  where variants.producto_id = p_product_id;

  update public.productos products
  set stock = coalesce((
    select sum(movements.quantity_delta)
    from public.inventory_movements movements
    where movements.product_id = products.id
      and movements.movement_date <= current_date
  ), 0)
  where products.id = p_product_id;

  perform set_config(
    'beyonix.inventory_refresh',
    v_previous_refresh_setting,
    true
  );
exception
  when others then
    perform set_config(
      'beyonix.inventory_refresh',
      v_previous_refresh_setting,
      true
    );
    raise;
end;
$$;

revoke all on function public.refresh_inventory_stock(bigint)
  from public, anon, authenticated;
grant execute on function public.refresh_inventory_stock(bigint)
  to service_role;

create or replace function public.set_product_variant_allocations(
  p_product_id bigint,
  p_allocations jsonb,
  p_actor_id uuid default null
)
returns table (
  variant_id bigint,
  allocated_quantity integer,
  available_quantity integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assignable_quantity bigint;
  v_requested_quantity bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para distribuir inventario.';
  end if;

  if p_product_id is null
     or jsonb_typeof(coalesce(p_allocations, '[]'::jsonb)) <> 'array' then
    raise exception 'La distribución indicada no es válida.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  if not exists (
    select 1 from public.productos where id = p_product_id
  ) then
    raise exception 'El producto ya no existe.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
    where requested.variant_id is null
       or requested.quantity is null
       or requested.quantity < 0
  ) then
    raise exception 'Las cantidades deben ser números enteros positivos.';
  end if;

  if (
    select count(*)
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
  ) <> (
    select count(distinct requested.variant_id)
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
  ) then
    raise exception 'Hay variantes repetidas en la distribución.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
    left join public.producto_variantes variants
      on variants.id = requested.variant_id
     and variants.producto_id = p_product_id
    where variants.id is null
  ) then
    raise exception 'Una de las variantes no pertenece al producto.';
  end if;

  select coalesce(sum(movements.quantity_delta), 0)
  into v_assignable_quantity
  from public.inventory_movements movements
  where movements.product_id = p_product_id
    and movements.variant_id is null
    and movements.movement_date <= current_date;

  select coalesce(sum(requested.quantity), 0)
  into v_requested_quantity
  from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
    as requested(variant_id bigint, quantity integer);

  if v_requested_quantity > greatest(v_assignable_quantity, 0) then
    raise exception
      'La distribución supera las % unidades disponibles.',
      greatest(v_assignable_quantity, 0);
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
      as requested(variant_id bigint, quantity integer)
    left join lateral (
      select coalesce(sum(movements.quantity_delta), 0) as physical_quantity
      from public.inventory_movements movements
      where movements.product_id = p_product_id
        and movements.variant_id = requested.variant_id
        and movements.movement_date <= current_date
    ) physical on true
    where physical.physical_quantity + requested.quantity < 0
  ) then
    raise exception
      'No podés asignar menos unidades que las ya vendidas en una variante.';
  end if;

  delete from public.inventory_variant_allocations allocations
  where allocations.product_id = p_product_id;

  insert into public.inventory_variant_allocations (
    product_id,
    variant_id,
    quantity,
    updated_by,
    updated_at
  )
  select
    p_product_id,
    requested.variant_id,
    requested.quantity,
    p_actor_id,
    now()
  from jsonb_to_recordset(coalesce(p_allocations, '[]'::jsonb))
    as requested(variant_id bigint, quantity integer)
  where requested.quantity > 0;

  perform public.refresh_inventory_stock(p_product_id);

  return query
  select
    variants.id,
    coalesce(allocations.quantity, 0),
    coalesce(variants.stock, 0)
  from public.producto_variantes variants
  left join public.inventory_variant_allocations allocations
    on allocations.variant_id = variants.id
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id;
end;
$$;

revoke all on function public.set_product_variant_allocations(bigint, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.set_product_variant_allocations(bigint, jsonb, uuid)
  to service_role;

do $$
declare
  v_product_id bigint;
begin
  for v_product_id in select id from public.productos loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;
end;
$$;

comment on table public.inventory_variant_allocations is
  'Clasificación del stock genérico comprado entre variantes, sin modificar el total físico.';
