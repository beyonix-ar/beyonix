-- Venta por color: tres modos explícitos y resolver único de códigos.
--
--   especifico           el cliente elige color (comportamiento de siempre).
--   aleatorio_variantes  random fulfillment con variantes físicas (venta_aleatoria
--                        = true): stock, reserva, armado y devolución por variante.
--   aleatorio_simple     un único artículo con stock total: el color físico no se
--                        sigue. El producto tiene a lo sumo UNA variante (nombre
--                        ALEATORIO) y todos sus códigos (principal, vinculados al
--                        producto completo, SKU) la identifican. Como venta_aleatoria
--                        queda en false, reservas, checkout, compras, devoluciones
--                        y stock usan el camino normal de una variante.
--
-- No modifica datos salvo el backfill del modo: los productos existentes quedan
-- 'especifico' o, si ya tenían venta_aleatoria, 'aleatorio_variantes'.

-- 1. Modo de venta por color -----------------------------------------------------
alter table public.productos
  add column if not exists modo_color text not null default 'especifico';
alter table public.productos
  add constraint productos_modo_color_check
    check (modo_color in ('especifico', 'aleatorio_simple', 'aleatorio_variantes'));

update public.productos set modo_color = 'aleatorio_variantes'
where venta_aleatoria and modo_color <> 'aleatorio_variantes';

-- venta_aleatoria sigue siendo la fuente de los flujos de random fulfillment
-- (reservas, checkout, armado): debe coincidir siempre con el modo.
alter table public.productos
  add constraint productos_modo_color_venta_aleatoria_check
    check (venta_aleatoria = (modo_color = 'aleatorio_variantes'));

comment on column public.productos.modo_color is
  'especifico | aleatorio_simple (un artículo, stock total, color no trazado) | aleatorio_variantes (random fulfillment por variante física; venta_aleatoria = true).';

create or replace function public.guard_catalog_barcode_alias()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.variant_id is not null and exists (
    select 1 from public.productos p where p.id = new.product_id and p.modo_color = 'aleatorio_simple'
  ) then
    raise exception 'RANDOM_SIMPLE_ALIAS_PRODUCT_SCOPE';
  end if;
  if new.variant_id is not null and not exists (
    select 1 from public.producto_variantes v where v.id = new.variant_id and v.producto_id = new.product_id
  ) then
    raise exception 'CATALOG_ALIAS_VARIANT_MISMATCH';
  end if;
  perform pg_advisory_xact_lock(93002, hashtext(new.normalized_barcode));
  if exists (select 1 from public.catalog_barcode_registry r where r.normalized_barcode = new.normalized_barcode) then
    raise exception 'CATALOG_BARCODE_DUPLICATE' using errcode = '23505';
  end if;
  return new;
end $$;

-- 2. Nombre de color derivado del hex (espejo de lib/products/variant-color.ts) ----
create or replace function public.variant_color_name_from_hex(p_hex text)
returns text language sql immutable
set search_path = pg_catalog, public, pg_temp as $$
  select case upper(btrim(coalesce(p_hex, '')))
    when '#000000' then 'NEGRO'
    when '#18181B' then 'NEGRO MATE'
    when '#FFFFFF' then 'BLANCO'
    when '#6B7280' then 'GRIS'
    when '#D1D5DB' then 'GRIS CLARO'
    when '#374151' then 'GRIS OSCURO'
    when '#2563EB' then 'AZUL'
    when '#38BDF8' then 'CELESTE'
    when '#EF4444' then 'ROJO'
    when '#22C55E' then 'VERDE'
    when '#FACC15' then 'AMARILLO'
    else case when upper(btrim(coalesce(p_hex, ''))) ~ '^#[0-9A-F]{6}$'
      then 'COLOR ' || upper(btrim(p_hex)) else 'COLOR PERSONALIZADO' end
  end
$$;

-- 3. Aleatorio simple: una sola variante, siempre llamada ALEATORIO ---------------
-- Corre antes que prevent_duplicate_product_variant_identity (orden alfabético).
create or replace function public.enforce_random_simple_variant()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  if exists (select 1 from public.productos p
             where p.id = new.producto_id and p.modo_color = 'aleatorio_simple') then
    if exists (select 1 from public.producto_variantes v
               where v.producto_id = new.producto_id and v.id is distinct from new.id) then
      raise exception 'RANDOM_SIMPLE_SINGLE_VARIANT';
    end if;
    new.nombre := 'ALEATORIO';
  end if;
  return new;
end $$;
drop trigger if exists enforce_random_simple_variant on public.producto_variantes;
create trigger enforce_random_simple_variant
  before insert or update of producto_id, nombre on public.producto_variantes
  for each row execute function public.enforce_random_simple_variant();

-- 4. Cambio de modo (bajo el mismo lock por producto que reservas y stock) --------
create or replace function public.set_product_color_mode(
  p_product_id bigint,
  p_mode text,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_product public.productos%rowtype;
  v_variants integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar la venta por color.';
  end if;
  if p_mode is null or p_mode not in ('especifico', 'aleatorio_simple', 'aleatorio_variantes') then
    raise exception 'COLOR_MODE_INVALID';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  perform set_config('beyonix.actor_id', coalesce(p_actor_id::text, ''), true);

  select * into v_product from public.productos where id = p_product_id for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;
  select count(*) into v_variants from public.producto_variantes where producto_id = p_product_id;

  if p_mode = 'aleatorio_variantes' and v_variants < 2 then
    raise exception 'RANDOM_FULFILLMENT_NEEDS_VARIANTS';
  end if;
  if p_mode = 'aleatorio_simple' and v_variants > 1 then
    raise exception 'RANDOM_SIMPLE_SINGLE_VARIANT';
  end if;
  if v_product.modo_color = p_mode then
    return v_product;
  end if;

  update public.productos
  set modo_color = p_mode, venta_aleatoria = (p_mode = 'aleatorio_variantes')
  where id = p_product_id
  returning * into v_product;

  if p_mode = 'aleatorio_simple' then
    -- El trigger fija el nombre ALEATORIO.
    update public.producto_variantes set nombre = 'ALEATORIO' where producto_id = p_product_id;
    -- Con un solo artículo físico, todos sus códigos adicionales pasan al
    -- producto completo. No se cambia el código ni se pierde su identidad.
    update public.catalog_barcode_aliases set variant_id = null
    where product_id = p_product_id and variant_id is not null;
  elsif exists (select 1 from public.producto_variantes
                where producto_id = p_product_id and nombre = 'ALEATORIO') then
    -- Sale de aleatorio simple: la variante vuelve a nombrarse por su color.
    update public.producto_variantes
    set nombre = public.variant_color_name_from_hex(color_hex)
      || case when color_hex_secundario is not null
           then ' / ' || public.variant_color_name_from_hex(color_hex_secundario) else '' end
    where producto_id = p_product_id and nombre = 'ALEATORIO';
  end if;
  return v_product;
end;
$$;

-- El RPC anterior (switch de venta aleatoria) delega en el nuevo.
create or replace function public.set_product_random_fulfillment(
  p_product_id bigint,
  p_enabled boolean,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar la venta aleatoria.';
  end if;
  if p_enabled is null then
    raise exception 'RANDOM_FULFILLMENT_INVALID';
  end if;
  return public.set_product_color_mode(
    p_product_id, case when p_enabled then 'aleatorio_variantes' else 'especifico' end, p_actor_id);
end;
$$;

-- 5. Resolver central de códigos -------------------------------------------------
-- Principal de producto o variante, vinculado (alias) de producto o variante, y
-- SKU. Un código que apunta a dos artículos distintos es un error administrativo
-- (nunca se elige uno). En aleatorio simple, un código del producto completo
-- identifica a su única variante.
create or replace function public.catalog_code_target(p_code text)
returns table(product_id bigint, variant_id bigint, matched_by text)
language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_products integer;
  v_targets integer;
  v_product bigint;
  v_variant bigint;
  v_matched text;
begin
  select count(distinct t.product_id),
         count(distinct (t.product_id, t.variant_id)),
         (array_agg(t.product_id order by t.priority))[1],
         (array_agg(t.variant_id order by t.priority))[1],
         (array_agg(t.matched_by order by t.priority))[1]
    into v_products, v_targets, v_product, v_variant, v_matched
  from (
    select raw.product_id,
           case when p.modo_color = 'aleatorio_simple' and raw.variant_id is null
             then (select v.id from public.producto_variantes v where v.producto_id = raw.product_id)
             else raw.variant_id end as variant_id,
           raw.matched_by, raw.priority
    from (
    select coalesce(r.product_id, v.producto_id) as product_id, r.variant_id, 'barcode'::text as matched_by, 1 as priority
    from public.catalog_barcode_registry r
    left join public.producto_variantes v on v.id = r.variant_id
    where r.normalized_barcode = public.normalized_catalog_barcode(p_code)
    union all
    select a.product_id, a.variant_id, 'alias'::text, 2
    from public.catalog_barcode_aliases a
    where a.normalized_barcode = public.normalized_catalog_barcode(p_code)
    union all
    select coalesce(s.product_id, v.producto_id), s.variant_id, 'sku'::text, 3
    from public.catalog_sku_registry s
    left join public.producto_variantes v on v.id = s.variant_id
    where s.normalized_sku = public.normalized_catalog_sku(p_code) and s.conditioned_stock_id is null
    ) raw
    join public.productos p on p.id = raw.product_id
  ) t
  where t.product_id is not null;

  if coalesce(v_products, 0) = 0 then return; end if;
  if v_products > 1 or v_targets > 1 then raise exception 'CATALOG_CODE_AMBIGUOUS'; end if;

  return query select v_product, v_variant, v_matched;
end $$;

revoke all on function public.catalog_code_target(text),
  public.set_product_color_mode(bigint, text, uuid),
  public.set_product_random_fulfillment(bigint, boolean, uuid),
  public.enforce_random_simple_variant()
  from public, anon, authenticated;
grant execute on function public.catalog_code_target(text),
  public.set_product_color_mode(bigint, text, uuid),
  public.set_product_random_fulfillment(bigint, boolean, uuid)
  to service_role;

notify pgrst, 'reload schema';
