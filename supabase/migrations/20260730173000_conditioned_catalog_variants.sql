-- Convierte cada lote devuelto con descuento en una oferta condicionada
-- independiente, vinculada a su variante original sin mezclar inventarios.

alter table public.inventory_return_movements
  add column if not exists conditioned_name text,
  add column if not exists conditioned_sku text,
  add column if not exists conditioned_color_hex text,
  add column if not exists conditioned_images jsonb not null default '[]'::jsonb;

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_conditioned_color_check,
  add constraint inventory_return_conditioned_color_check check (
    conditioned_color_hex is null
    or conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$'
  ),
  drop constraint if exists inventory_return_conditioned_images_check,
  add constraint inventory_return_conditioned_images_check check (
    jsonb_typeof(conditioned_images) = 'array'
  );

with backfill as (
  select
    movements.id,
    products.nombre as product_name,
    products.sku as product_sku,
    products.imagen_principal,
    variants.nombre as variant_name,
    variants.sku as variant_sku,
    variants.color_hex as variant_color_hex,
    variants.imagenes as variant_images
  from public.inventory_return_movements movements
  join public.productos products on products.id = movements.product_id
  left join public.producto_variantes variants
    on variants.id = movements.variant_id
  where movements.discounted_quantity > 0
)
update public.inventory_return_movements movements
set conditioned_name = coalesce(
      nullif(btrim(movements.conditioned_name), ''),
      nullif(btrim(backfill.variant_name), '') || ' · Con descuento',
      nullif(btrim(backfill.product_name), '') || ' · Con descuento'
    ),
    conditioned_sku = coalesce(
      nullif(btrim(movements.conditioned_sku), ''),
      left(
        coalesce(
          nullif(btrim(backfill.variant_sku), ''),
          nullif(btrim(backfill.product_sku), ''),
          'COND'
        ),
        96
      )
      || '-DESC-'
      || upper(substr(replace(movements.id::text, '-', ''), 1, 8))
    ),
    conditioned_color_hex = coalesce(
      nullif(btrim(movements.conditioned_color_hex), ''),
      backfill.variant_color_hex,
      '#000000'
    ),
    conditioned_images = case
      when jsonb_array_length(coalesce(movements.conditioned_images, '[]'::jsonb)) > 0
        then movements.conditioned_images
      when jsonb_array_length(coalesce(backfill.variant_images, '[]'::jsonb)) > 0
        then backfill.variant_images
      when backfill.imagen_principal is not null
        then jsonb_build_array(backfill.imagen_principal)
      else '[]'::jsonb
    end
from backfill
where backfill.id = movements.id;

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_conditioned_identity_check,
  add constraint inventory_return_conditioned_identity_check check (
    discounted_quantity <= 0
    or not conditioned_active
    or (
      nullif(btrim(conditioned_name), '') is not null
      and nullif(btrim(conditioned_sku), '') is not null
      and conditioned_color_hex ~ '^#[0-9A-Fa-f]{6}$'
    )
  );

alter table public.catalog_sku_registry
  add column if not exists conditioned_stock_id uuid unique
    references public.inventory_return_movements(id) on delete cascade;

alter table public.catalog_sku_registry
  drop constraint if exists catalog_sku_registry_owner_check,
  add constraint catalog_sku_registry_owner_check check (
    (product_id is not null)::integer
    + (variant_id is not null)::integer
    + (conditioned_stock_id is not null)::integer = 1
  );

insert into public.catalog_sku_registry (
  normalized_sku,
  product_id,
  variant_id,
  conditioned_stock_id
)
select
  public.normalized_catalog_sku(movements.conditioned_sku),
  null::bigint,
  null::bigint,
  movements.id
from public.inventory_return_movements movements
where movements.discounted_quantity > 0
  and public.normalized_catalog_sku(movements.conditioned_sku) is not null
on conflict (normalized_sku) do nothing;

do $$
declare
  v_conditioned_skus bigint;
  v_registered_conditioned_skus bigint;
begin
  select count(*)
  into v_conditioned_skus
  from public.inventory_return_movements movements
  where movements.discounted_quantity > 0
    and public.normalized_catalog_sku(movements.conditioned_sku) is not null;

  select count(*)
  into v_registered_conditioned_skus
  from public.catalog_sku_registry registry
  where registry.conditioned_stock_id is not null;

  if v_conditioned_skus <> v_registered_conditioned_skus then
    raise exception
      'Hay SKU duplicados entre ofertas condicionadas y el catálogo principal.';
  end if;
end;
$$;

create or replace function public.sync_conditioned_catalog_sku_registry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.conditioned_sku is not null then
    delete from public.catalog_sku_registry registry
    where registry.conditioned_stock_id = old.id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  v_sku := public.normalized_catalog_sku(new.conditioned_sku);
  if v_sku is null or new.discounted_quantity <= 0 then
    return new;
  end if;

  insert into public.catalog_sku_registry (
    normalized_sku,
    product_id,
    variant_id,
    conditioned_stock_id
  )
  values (v_sku, null, null, new.id);

  return new;
exception
  when unique_violation then
    raise exception
      'El SKU % ya está asignado a otro artículo.',
      new.conditioned_sku;
end;
$$;

drop trigger if exists sync_conditioned_catalog_sku_registry
  on public.inventory_return_movements;
create trigger sync_conditioned_catalog_sku_registry
after insert or delete or update of conditioned_sku, discounted_quantity
on public.inventory_return_movements
for each row execute function public.sync_conditioned_catalog_sku_registry();

create index if not exists inventory_return_conditioned_catalog_idx
  on public.inventory_return_movements (
    product_id,
    conditioned_active,
    approved_at desc
  )
  where discounted_quantity > 0;

comment on column public.inventory_return_movements.variant_id is
  'Variante original de la que proviene la unidad devuelta.';
comment on column public.inventory_return_movements.conditioned_sku is
  'SKU exclusivo de la oferta vendible con descuento.';
comment on column public.inventory_return_movements.conditioned_images is
  'Imágenes propias de la oferta condicionada; inicialmente hereda las de la variante original.';
