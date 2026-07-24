alter table public.productos
  add column if not exists sku text;

alter table public.productos
  add column if not exists created_from_costs boolean not null default false;

create index if not exists productos_sku_search_idx
  on public.productos (lower(sku))
  where sku is not null;

create or replace function public.ensure_cost_catalog_product(
  p_name text,
  p_sku text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(p_name), '');
  v_sku text := nullif(btrim(p_sku), '');
  v_key text;
  v_product_id bigint;
begin
  if v_name is null then
    raise exception 'El artículo debe tener un nombre.';
  end if;

  select id
    into v_product_id
  from public.productos
  where created_from_costs
    and (
      (v_sku is not null and lower(btrim(sku)) = lower(v_sku))
      or lower(btrim(nombre)) = lower(v_name)
    )
  order by id
  limit 1;

  if v_product_id is not null then
    update public.productos
    set sku = coalesce(v_sku, sku)
    where id = v_product_id;
    return v_product_id;
  end if;

  v_key := lower(coalesce(v_sku, v_name));

  insert into public.productos (
    nombre,
    slug,
    descripcion,
    precio,
    precio_anterior,
    descuento,
    cuotas_sin_interes,
    cuotas_maximas,
    stock,
    categoria_id,
    destacado,
    activo,
    imagen_principal,
    video_url,
    sku,
    created_from_costs
  ) values (
    v_name,
    'costos-' || substr(md5(v_key), 1, 24),
    null,
    0,
    null,
    null,
    false,
    null,
    0,
    null,
    false,
    false,
    null,
    null,
    v_sku,
    true
  )
  returning id into v_product_id;

  return v_product_id;
end;
$$;

create or replace function public.link_cost_entry_to_shared_catalog()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_id is null and nullif(btrim(new.article_name), '') is not null then
    new.product_id := public.ensure_cost_catalog_product(new.article_name, new.sku);
  end if;
  return new;
end;
$$;

drop trigger if exists link_cost_entry_to_shared_catalog
  on public.product_cost_entries;

create trigger link_cost_entry_to_shared_catalog
before insert or update of product_id, article_name, sku
on public.product_cost_entries
for each row execute function public.link_cost_entry_to_shared_catalog();

create or replace function public.sync_cost_catalog_product_sku()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.product_id is not null and nullif(btrim(new.sku), '') is not null then
    update public.productos
    set sku = btrim(new.sku)
    where id = new.product_id
      and created_from_costs;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_cost_catalog_product_sku
  on public.product_cost_entries;

create trigger sync_cost_catalog_product_sku
after insert or update of sku
on public.product_cost_entries
for each row execute function public.sync_cost_catalog_product_sku();

update public.product_cost_entries
set product_id = public.ensure_cost_catalog_product(article_name, sku)
where product_id is null
  and nullif(btrim(article_name), '') is not null;

comment on column public.productos.sku is
  'SKU operativo compartido por catálogo, costos y ventas.';

comment on column public.productos.created_from_costs is
  'Indica que el producto fue creado automáticamente desde Costos reales.';
