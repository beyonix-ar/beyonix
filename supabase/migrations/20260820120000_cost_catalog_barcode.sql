-- Código de barra para productos y variantes: permite identificar un
-- artículo escaneando su envase, igual que el SKU pero pensado para
-- lectura física en vez de tipeo. Mismo patrón de identidad única y
-- transaccional que catalog_sku_registry (20260730172000).

alter table public.productos
  add column if not exists codigo_barra text;

alter table public.producto_variantes
  add column if not exists codigo_barra text;

create or replace function public.normalized_catalog_barcode(p_barcode text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(btrim(coalesce(p_barcode, '')), '');
$$;

create table if not exists public.catalog_barcode_registry (
  normalized_barcode text primary key,
  product_id bigint unique
    references public.productos(id) on delete cascade,
  variant_id bigint unique
    references public.producto_variantes(id) on delete cascade,
  constraint catalog_barcode_registry_owner_check check (
    (product_id is not null)::integer
    + (variant_id is not null)::integer = 1
  )
);

insert into public.catalog_barcode_registry (
  normalized_barcode,
  product_id,
  variant_id
)
select
  public.normalized_catalog_barcode(products.codigo_barra),
  products.id,
  null::bigint
from public.productos products
where public.normalized_catalog_barcode(products.codigo_barra) is not null
on conflict (normalized_barcode) do nothing;

insert into public.catalog_barcode_registry (
  normalized_barcode,
  product_id,
  variant_id
)
select
  public.normalized_catalog_barcode(variants.codigo_barra),
  null::bigint,
  variants.id
from public.producto_variantes variants
where public.normalized_catalog_barcode(variants.codigo_barra) is not null
on conflict (normalized_barcode) do nothing;

create or replace function public.sync_product_catalog_barcode_registry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barcode text;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.codigo_barra is not null then
    delete from public.catalog_barcode_registry registry
    where registry.product_id = old.id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_barcode := public.normalized_catalog_barcode(new.codigo_barra);
  if v_barcode is not null then
    insert into public.catalog_barcode_registry (
      normalized_barcode,
      product_id,
      variant_id
    )
    values (v_barcode, new.id, null);
  end if;

  return new;
exception
  when unique_violation then
    raise exception 'El código de barra % ya está asignado a otro artículo.', new.codigo_barra;
end;
$$;

drop trigger if exists sync_product_catalog_barcode_registry
  on public.productos;
create trigger sync_product_catalog_barcode_registry
after insert or delete or update of codigo_barra
on public.productos
for each row execute function public.sync_product_catalog_barcode_registry();

create or replace function public.sync_variant_catalog_barcode_registry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barcode text;
  v_registered_product_id bigint;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.codigo_barra is not null then
    delete from public.catalog_barcode_registry registry
    where registry.variant_id = old.id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_barcode := public.normalized_catalog_barcode(new.codigo_barra);
  if v_barcode is null then
    return new;
  end if;

  select registry.product_id
  into v_registered_product_id
  from public.catalog_barcode_registry registry
  where registry.normalized_barcode = v_barcode
  for update;

  if found and v_registered_product_id = new.producto_id then
    update public.catalog_barcode_registry
    set product_id = null,
        variant_id = new.id
    where normalized_barcode = v_barcode;
  else
    insert into public.catalog_barcode_registry (
      normalized_barcode,
      product_id,
      variant_id
    )
    values (v_barcode, null, new.id);
  end if;

  return new;
exception
  when unique_violation then
    raise exception 'El código de barra % ya está asignado a otro artículo.', new.codigo_barra;
end;
$$;

drop trigger if exists sync_variant_catalog_barcode_registry
  on public.producto_variantes;
create trigger sync_variant_catalog_barcode_registry
after insert or delete or update of codigo_barra
on public.producto_variantes
for each row execute function public.sync_variant_catalog_barcode_registry();

revoke all on public.catalog_barcode_registry
  from public, anon, authenticated;
grant select, insert, update, delete on public.catalog_barcode_registry
  to service_role;

comment on column public.productos.codigo_barra is
  'Código de barra físico del producto, usado para identificarlo al escanear (solo cuando no tiene variantes).';
comment on column public.producto_variantes.codigo_barra is
  'Código de barra físico de la variante, usado para identificarla al escanear.';
comment on table public.catalog_barcode_registry is
  'Identidad de código de barra única y transaccional compartida por productos y variantes.';
