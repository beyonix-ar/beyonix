-- Registro único para impedir carreras entre SKU de productos y variantes.
-- Dos transacciones concurrentes no pueden apropiarse del mismo SKU.

create table if not exists public.catalog_sku_registry (
  normalized_sku text primary key,
  product_id bigint unique
    references public.productos(id) on delete cascade,
  variant_id bigint unique
    references public.producto_variantes(id) on delete cascade,
  constraint catalog_sku_registry_owner_check check (
    (product_id is not null)::integer
    + (variant_id is not null)::integer = 1
  )
);

insert into public.catalog_sku_registry (
  normalized_sku,
  product_id,
  variant_id
)
select
  public.normalized_catalog_sku(products.sku),
  products.id,
  null::bigint
from public.productos products
where public.normalized_catalog_sku(products.sku) is not null
on conflict (normalized_sku) do nothing;

insert into public.catalog_sku_registry (
  normalized_sku,
  product_id,
  variant_id
)
select
  public.normalized_catalog_sku(variants.sku),
  null::bigint,
  variants.id
from public.producto_variantes variants
where public.normalized_catalog_sku(variants.sku) is not null
on conflict (normalized_sku) do nothing;

do $$
declare
  v_catalog_skus bigint;
  v_registered_skus bigint;
begin
  select count(*)
  into v_catalog_skus
  from (
    select public.normalized_catalog_sku(products.sku) as sku
    from public.productos products
    where public.normalized_catalog_sku(products.sku) is not null
    union all
    select public.normalized_catalog_sku(variants.sku)
    from public.producto_variantes variants
    where public.normalized_catalog_sku(variants.sku) is not null
  ) catalog;

  select count(*)
  into v_registered_skus
  from public.catalog_sku_registry;

  if v_catalog_skus <> v_registered_skus then
    raise exception
      'Hay SKU duplicados en el catálogo; no se creó el registro de identidad.';
  end if;
end;
$$;

create or replace function public.sync_product_catalog_sku_registry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.sku is not null then
    delete from public.catalog_sku_registry registry
    where registry.product_id = old.id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_sku := public.normalized_catalog_sku(new.sku);
  if v_sku is not null then
    insert into public.catalog_sku_registry (
      normalized_sku,
      product_id,
      variant_id
    )
    values (v_sku, new.id, null);
  end if;

  return new;
exception
  when unique_violation then
    raise exception 'El SKU % ya está asignado a otro artículo.', new.sku;
end;
$$;

drop trigger if exists sync_product_catalog_sku_registry
  on public.productos;
create trigger sync_product_catalog_sku_registry
after insert or delete or update of sku
on public.productos
for each row execute function public.sync_product_catalog_sku_registry();

create or replace function public.sync_variant_catalog_sku_registry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
  v_registered_product_id bigint;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.sku is not null then
    delete from public.catalog_sku_registry registry
    where registry.variant_id = old.id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_sku := public.normalized_catalog_sku(new.sku);
  if v_sku is null then
    return new;
  end if;

  select registry.product_id
  into v_registered_product_id
  from public.catalog_sku_registry registry
  where registry.normalized_sku = v_sku
  for update;

  if found and v_registered_product_id = new.producto_id then
    update public.catalog_sku_registry
    set product_id = null,
        variant_id = new.id
    where normalized_sku = v_sku;
  else
    insert into public.catalog_sku_registry (
      normalized_sku,
      product_id,
      variant_id
    )
    values (v_sku, null, new.id);
  end if;

  return new;
exception
  when unique_violation then
    raise exception 'El SKU % ya está asignado a otro artículo.', new.sku;
end;
$$;

drop trigger if exists sync_variant_catalog_sku_registry
  on public.producto_variantes;
create trigger sync_variant_catalog_sku_registry
after insert or delete or update of sku
on public.producto_variantes
for each row execute function public.sync_variant_catalog_sku_registry();

revoke all on public.catalog_sku_registry
  from public, anon, authenticated;
grant select, insert, update, delete on public.catalog_sku_registry
  to service_role;

comment on table public.catalog_sku_registry is
  'Identidad SKU única y transaccional compartida por productos y variantes.';
