-- Catálogo: venta con color/modelo aleatorio, variantes de dos colores y
-- códigos de barra equivalentes. Sólo agrega columnas/tabla y redefine
-- funciones existentes; no modifica datos (los productos actuales quedan con
-- venta_aleatoria = false y se comportan igual que antes).

-- 1. Columnas -----------------------------------------------------------------
alter table public.productos
  add column if not exists venta_aleatoria boolean not null default false;
comment on column public.productos.venta_aleatoria is
  'El cliente no elige color/modelo: BEYONIX cumple con cualquier variante física activa con stock. Nunca inventa colores.';

alter table public.producto_variantes
  add column if not exists color_hex_secundario text;
alter table public.producto_variantes
  add constraint producto_variantes_color_hex_secundario_check
    check (color_hex_secundario is null or color_hex_secundario ~* '^#[0-9a-f]{6}$');
comment on column public.producto_variantes.color_hex_secundario is
  'Segundo color de una variante bicolor (Azul / Rosa). La variante aparece al filtrar por cualquiera de los dos.';

alter table public.orden_items
  add column if not exists random_fulfillment boolean not null default false;
comment on column public.orden_items.random_fulfillment is
  'Unidad vendida como color aleatorio: variante_id es la variante física asignada (al reservar y, si se escanea otra elegible, al armar).';

-- 2. Códigos de barra equivalentes ------------------------------------------
-- Un código es único en todo el catálogo (registro principal + alias). Un
-- alias con variante identifica esa variante física; sin variante identifica
-- al grupo comercial (p. ej. el mismo EAN del fabricante para todos los colores).
create table if not exists public.catalog_barcode_aliases (
  normalized_barcode text primary key,
  barcode text not null check (length(btrim(barcode)) between 1 and 64),
  product_id bigint not null references public.productos(id) on delete cascade,
  variant_id bigint references public.producto_variantes(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (normalized_barcode = public.normalized_catalog_barcode(barcode)),
  check (upper(normalized_barcode) !~ '^(BX-PKG-|DSP-)')
);
create index if not exists catalog_barcode_aliases_product_idx on public.catalog_barcode_aliases(product_id);
create index if not exists catalog_barcode_aliases_variant_idx on public.catalog_barcode_aliases(variant_id);

alter table public.catalog_barcode_aliases enable row level security;
revoke all on public.catalog_barcode_aliases from public, anon, authenticated;
grant select on public.catalog_barcode_aliases to authenticated;
grant select, insert, update, delete on public.catalog_barcode_aliases to service_role;
create policy catalog_barcode_aliases_internal_read on public.catalog_barcode_aliases
  for select to authenticated using (public.is_current_user_internal());

create or replace function public.guard_catalog_barcode_alias()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.variant_id is not null and not exists (
    select 1 from public.producto_variantes v where v.id = new.variant_id and v.producto_id = new.product_id
  ) then
    raise exception 'CATALOG_ALIAS_VARIANT_MISMATCH';
  end if;
  -- Mismo candado que el registro principal: alta concurrente de un código
  -- como alias y como código principal no puede pasar ambos chequeos.
  perform pg_advisory_xact_lock(93002, hashtext(new.normalized_barcode));
  if exists (select 1 from public.catalog_barcode_registry r where r.normalized_barcode = new.normalized_barcode) then
    raise exception 'CATALOG_BARCODE_DUPLICATE' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger guard_catalog_barcode_alias before insert or update on public.catalog_barcode_aliases
  for each row execute function public.guard_catalog_barcode_alias();

-- El registro principal tampoco puede tomar un código que ya es alias. Se
-- informa como unique_violation para que los mensajes existentes de
-- "código duplicado" (sync_*_catalog_barcode_registry) sigan aplicando.
create or replace function public.guard_catalog_barcode_registry_alias()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.normalized_barcode is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(93002, hashtext(new.normalized_barcode));
  if exists (select 1 from public.catalog_barcode_aliases a where a.normalized_barcode = new.normalized_barcode) then
    raise exception 'CATALOG_BARCODE_DUPLICATE' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger guard_catalog_barcode_registry_alias before insert or update on public.catalog_barcode_registry
  for each row execute function public.guard_catalog_barcode_registry_alias();

-- Dueño de un código escaneado: código principal, alias o SKU. Una sola fila.
create or replace function public.catalog_code_target(p_code text)
returns table(product_id bigint, variant_id bigint, matched_by text)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select * from (
    select coalesce(r.product_id, v.producto_id), r.variant_id, 'barcode'::text
    from public.catalog_barcode_registry r
    left join public.producto_variantes v on v.id = r.variant_id
    where r.normalized_barcode = public.normalized_catalog_barcode(p_code)
    union all
    select a.product_id, a.variant_id, 'alias'::text
    from public.catalog_barcode_aliases a
    where a.normalized_barcode = public.normalized_catalog_barcode(p_code)
    union all
    select coalesce(s.product_id, v.producto_id), s.variant_id, 'sku'::text
    from public.catalog_sku_registry s
    left join public.producto_variantes v on v.id = s.variant_id
    where s.normalized_sku = public.normalized_catalog_sku(p_code) and s.conditioned_stock_id is null
  ) targets
  limit 1
$$;

-- 3. Stock disponible: un producto aleatorio sin variante elegida suma lo
-- disponible de sus variantes físicas activas (cada una con sus reservas).
create or replace function public.available_stock_for_session(
  p_product_id bigint,
  p_variant_id bigint,
  p_conditioned_stock_id uuid,
  p_session_id text
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stock integer;
  v_reserved_other integer;
begin
  if p_conditioned_stock_id is null and p_variant_id is null and exists (
    select 1 from public.productos where id = p_product_id and activo and venta_aleatoria
  ) and exists (
    select 1 from public.producto_variantes where producto_id = p_product_id and activo
  ) then
    return coalesce((
      select sum(greatest(public.available_stock_for_session(p_product_id, variants.id, null, p_session_id), 0))
      from public.producto_variantes variants
      where variants.producto_id = p_product_id and variants.activo
    ), 0)::integer;
  end if;

  if p_conditioned_stock_id is not null then
    select offers.available_quantity into v_stock
    from public.conditioned_inventory_offers offers
    where offers.id = p_conditioned_stock_id
      and offers.product_id = p_product_id;
  elsif p_variant_id is not null then
    select coalesce(variants.stock, 0) into v_stock
    from public.producto_variantes variants
    where variants.id = p_variant_id
      and variants.producto_id = p_product_id
      and variants.activo;
  else
    select coalesce(products.stock, 0) into v_stock
    from public.productos products
    where products.id = p_product_id and products.activo;
  end if;

  if not found then return null; end if;

  select coalesce(sum(reservations.quantity), 0)::integer
  into v_reserved_other
  from public.stock_reservations reservations
  where reservations.product_id = p_product_id
    and reservations.variant_id is not distinct from p_variant_id
    and reservations.conditioned_stock_id is not distinct from p_conditioned_stock_id
    and reservations.expires_at > now()
    and (p_session_id is null or reservations.session_id is distinct from p_session_id);

  return coalesce(v_stock, 0) - coalesce(v_reserved_other, 0);
end;
$$;

-- 4. Reserva del Paso 3 con asignación aleatoria ----------------------------
-- Idéntica a 20260925120000 salvo un caso: un producto con venta_aleatoria
-- pedido sin variante se reparte entre variantes físicas activas con stock
-- disponible (la de más disponibilidad primero), bajo el MISMO lock por
-- producto: dos clientes nunca reservan la misma unidad.
create or replace function public.reserve_cart_stock(p_session_id text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_session public.checkout_reservation_sessions%rowtype;
  v_item record;
  v_variant record;
  v_product_id bigint;
  v_available integer;
  v_count integer;
  v_now timestamptz;
  v_remaining integer;
  v_take integer;
begin
  if p_session_id is null or length(btrim(p_session_id)) < 8
     or length(p_session_id) > 160 then
    raise exception 'INVALID_SESSION';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_QUANTITY';
  end if;

  perform pg_advisory_xact_lock(93001, hashtext(p_session_id));
  v_now := clock_timestamp();
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id;

  if found then
    if v_session.order_id is not null then raise exception 'RESERVATION_LOCKED_TO_ORDER'; end if;
    if v_session.user_id is not null and v_session.user_id is distinct from auth.uid() then
      raise exception 'INVALID_SESSION';
    end if;
    if v_session.expires_at <= v_now then raise exception 'RESERVATION_EXPIRED'; end if;
  elsif jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_SESSION';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'quantity', '') !~ '^[123]$'
  ) then raise exception 'INVALID_QUANTITY'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'productId', item ->> 'product_id', '') !~ '^[0-9]{1,18}$'
       or (coalesce(item ->> 'variantId', item ->> 'variant_id') is not null
           and coalesce(item ->> 'variantId', item ->> 'variant_id') !~ '^[0-9]{1,18}$')
       or (coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id') is not null
           and coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')
               !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then raise exception 'INVALID_VARIANT'; end if;

  select count(*) into v_count from (
    select 1 from jsonb_array_elements(p_items) item
    group by coalesce(item ->> 'productId', item ->> 'product_id'),
             coalesce(item ->> 'variantId', item ->> 'variant_id'),
             coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')
    having sum((item ->> 'quantity')::integer) > 3
  ) excessive;
  if v_count > 0 then raise exception 'INVALID_QUANTITY'; end if;

  for v_product_id in
    select distinct product_id from (
      select coalesce(item ->> 'productId', item ->> 'product_id')::bigint as product_id
      from jsonb_array_elements(p_items) item
      union
      select product_id from public.stock_reservations where session_id = p_session_id
    ) targets order by 1
  loop
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;

  v_now := clock_timestamp();
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id;
  if found and v_session.order_id is not null then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;
  if found and v_session.expires_at <= v_now then
    raise exception 'RESERVATION_EXPIRED';
  end if;
  if exists (select 1 from public.stock_reservations
             where session_id = p_session_id and order_id is not null) then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;

  if not exists (select 1 from public.checkout_reservation_sessions where session_id = p_session_id) then
    insert into public.checkout_reservation_sessions
      (session_id, user_id, reservation_started_at, expires_at)
    values (p_session_id, auth.uid(), v_now, v_now + public.checkout_step_reservation_ttl())
    returning * into v_session;
  elsif v_session.user_id is null and auth.uid() is not null then
    update public.checkout_reservation_sessions set user_id = auth.uid()
    where session_id = p_session_id;
  end if;

  delete from public.stock_reservations where session_id = p_session_id;
  for v_item in
    select coalesce(item ->> 'productId', item ->> 'product_id')::bigint as product_id,
           coalesce(item ->> 'variantId', item ->> 'variant_id')::bigint as variant_id,
           coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')::uuid as conditioned_stock_id,
           sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) item
    group by 1, 2, 3 order by 1, 2 nulls first, 3 nulls first
  loop
    if v_item.product_id <= 0 or v_item.variant_id <= 0
       or (v_item.variant_id is not null and v_item.conditioned_stock_id is not null)
       or not exists (select 1 from public.productos
                      where id = v_item.product_id and activo) then
      raise exception 'INVALID_VARIANT';
    end if;

    if v_item.variant_id is null and v_item.conditioned_stock_id is null
       and exists (select 1 from public.producto_variantes
                   where producto_id = v_item.product_id and activo) then
      if not exists (select 1 from public.productos
                     where id = v_item.product_id and venta_aleatoria) then
        raise exception 'INVALID_VARIANT';
      end if;
      -- Venta aleatoria: unidades reales del pool, nunca un color inexistente.
      v_remaining := v_item.quantity;
      for v_variant in
        select variants.id,
               public.available_stock_for_session(v_item.product_id, variants.id, null, p_session_id)
                 - coalesce((select sum(own.quantity) from public.stock_reservations own
                             where own.session_id = p_session_id and own.product_id = v_item.product_id
                               and own.variant_id = variants.id), 0) as available
        from public.producto_variantes variants
        where variants.producto_id = v_item.product_id and variants.activo
        order by 2 desc, variants.id
      loop
        exit when v_remaining = 0;
        v_take := least(v_remaining, greatest(v_variant.available, 0));
        continue when v_take = 0;
        if exists (select 1 from public.stock_reservations
                   where session_id = p_session_id and product_id = v_item.product_id
                     and variant_id = v_variant.id and conditioned_stock_id is null) then
          update public.stock_reservations set quantity = quantity + v_take
          where session_id = p_session_id and product_id = v_item.product_id
            and variant_id = v_variant.id and conditioned_stock_id is null;
        else
          insert into public.stock_reservations
            (session_id, user_id, product_id, variant_id, conditioned_stock_id, quantity, expires_at)
          values (p_session_id, coalesce(v_session.user_id, auth.uid()),
                  v_item.product_id, v_variant.id, null, v_take, v_session.expires_at);
        end if;
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0 then raise exception 'OUT_OF_STOCK'; end if;
      continue;
    end if;

    v_available := public.available_stock_for_session(
      v_item.product_id, v_item.variant_id, v_item.conditioned_stock_id, p_session_id
    );
    if v_available is null then raise exception 'INVALID_VARIANT'; end if;
    if v_available < v_item.quantity then raise exception 'OUT_OF_STOCK'; end if;
    insert into public.stock_reservations
      (session_id, user_id, product_id, variant_id, conditioned_stock_id,
       quantity, expires_at)
    values (p_session_id, coalesce(v_session.user_id, auth.uid()),
            v_item.product_id, v_item.variant_id, v_item.conditioned_stock_id,
            v_item.quantity, v_session.expires_at);
  end loop;

  return jsonb_build_object('reserved', jsonb_array_length(p_items) > 0,
                            'reservation_started_at', v_session.reservation_started_at,
                            'expires_at', v_session.expires_at);
end;
$$;

-- 5. Armado -------------------------------------------------------------------
-- Registro común de un escaneo válido (mismo efecto que antes).
create or replace function public.register_order_preparation_scan(
  p_package public.order_packages, p_order_id bigint, p_order_item_id bigint,
  p_code text, p_actor_id uuid, p_request_key uuid)
returns public.order_packages language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_package public.order_packages%rowtype := p_package;
begin
  update public.order_preparation_lines set scanned_quantity = scanned_quantity + 1
    where package_id = v_package.id and order_item_id = p_order_item_id;
  insert into public.order_preparation_scans(package_id,attempt_number,order_item_id,request_key,code,scanned_by)
    values (v_package.id,v_package.attempt_number,p_order_item_id,p_request_key,btrim(p_code),p_actor_id);
  if not exists (select 1 from public.order_preparation_lines
                 where package_id = v_package.id and scanned_quantity <> expected_quantity) then
    update public.order_packages set status = 'prepared', prepared_at = now(), prepared_by = p_actor_id
      where id = v_package.id returning * into v_package;
    insert into public.order_audit_events(order_id,actor_type,actor_id,action,metadata)
      values (p_order_id,'admin',p_actor_id,'order_prepared',jsonb_build_object('packageId',v_package.id));
  end if;
  return v_package;
end $$;

-- ¿El código corresponde al renglón? Código esperado, alias de la misma
-- variante, o (renglón aleatorio) código del grupo o de la variante asignada.
create or replace function public.order_preparation_code_matches(
  p_line public.order_preparation_lines, p_code text)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_target record; v_random boolean;
begin
  if (p_line.expected_sku is not null and p_line.expected_sku = public.normalized_catalog_sku(p_code))
     or (p_line.expected_barcode is not null and p_line.expected_barcode = public.normalized_catalog_barcode(p_code)) then
    return true;
  end if;
  if p_line.conditioned_stock_id is not null then return false; end if;
  select * into v_target from public.catalog_code_target(p_code);
  if not found or v_target.product_id is distinct from p_line.product_id then return false; end if;
  if v_target.variant_id is not null then return v_target.variant_id = p_line.variant_id; end if;
  select random_fulfillment into v_random from public.orden_items where id = p_line.order_item_id;
  -- Código del grupo: sólo identifica la variante si el producto no tiene otra.
  return coalesce(v_random, false) or p_line.variant_id is null;
end $$;

create or replace function public.scan_order_preparation_item(
  p_order_id bigint, p_order_item_id bigint, p_code text, p_actor_id uuid, p_request_key uuid)
returns public.order_packages language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_package public.order_packages%rowtype; v_line public.order_preparation_lines%rowtype;
  v_existing_scan public.order_preparation_scans%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or nullif(btrim(coalesce(p_code,'')),'') is null then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  select * into v_existing_scan from public.order_preparation_scans
    where package_id = v_package.id and attempt_number=v_package.attempt_number
      and request_key = p_request_key;
  if found then
    if v_existing_scan.order_item_id <> p_order_item_id or v_existing_scan.code <> btrim(p_code) then
      raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    return v_package;
  end if;
  if v_package.status <> 'preparing' then raise exception 'DISPATCH_ALREADY_PREPARED'; end if;
  if exists (select 1 from unnest(public.dispatch_order_block_reasons(p_order_id)) r
             where r not in ('invoice_pending','shipment_pending'))
     or exists (select 1 from public.dispatch_blocks where order_id=p_order_id
                and source='manual' and resolved_at is null) then raise exception 'DISPATCH_ORDER_BLOCKED'; end if;
  select * into v_line from public.order_preparation_lines
    where package_id = v_package.id and order_item_id = p_order_item_id for update;
  if not found then raise exception 'DISPATCH_WRONG_ITEM'; end if;
  if not public.order_preparation_code_matches(v_line, p_code) then
    raise exception 'DISPATCH_WRONG_SKU_OR_VARIANT'; end if;
  if v_line.scanned_quantity >= v_line.expected_quantity then raise exception 'DISPATCH_QUANTITY_EXCEEDED'; end if;
  return public.register_order_preparation_scan(v_package, p_order_id, p_order_item_id, p_code, p_actor_id, p_request_key);
end $$;

-- Asigna a un renglón aleatorio (1 unidad, sin escanear) la variante física
-- escaneada. Primero el renglón de armado y después orden_items: así el
-- control de "ítems cambiados" del despacho ve ambos coherentes. El stock
-- de la variante nueva se valida bajo el lock del producto (incluye reservas
-- vigentes de otros clientes); la anterior recupera la unidad en el libro.
create or replace function public.assign_random_order_line_variant(
  p_package public.order_packages, p_order_id bigint, p_order_item_id bigint,
  p_variant_id bigint, p_actor_id uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_item public.orden_items%rowtype; v_variant public.producto_variantes%rowtype;
begin
  select * into v_item from public.orden_items where id = p_order_item_id and orden_id = p_order_id for update;
  if not found or not v_item.random_fulfillment or v_item.cantidad <> 1 then
    raise exception 'DISPATCH_WRONG_SKU_OR_VARIANT'; end if;
  perform pg_advisory_xact_lock(93000, v_item.producto_id::integer);
  select * into v_variant from public.producto_variantes
    where id = p_variant_id and producto_id = v_item.producto_id and activo;
  if not found then raise exception 'DISPATCH_WRONG_SKU_OR_VARIANT'; end if;
  if coalesce(public.available_stock_for_session(v_item.producto_id, p_variant_id, null, null), 0) < 1 then
    raise exception 'DISPATCH_RANDOM_VARIANT_NO_STOCK'; end if;
  update public.order_preparation_lines set variant_id = p_variant_id,
      expected_sku = public.normalized_catalog_sku(v_variant.sku),
      expected_barcode = public.normalized_catalog_barcode(v_variant.codigo_barra)
    where package_id = p_package.id and order_item_id = p_order_item_id;
  update public.orden_items set variante_id = p_variant_id where id = p_order_item_id;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,metadata)
    values (p_order_id,'admin',p_actor_id,'random_variant_assigned',
      jsonb_build_object('orderItemId',p_order_item_id,'fromVariantId',v_item.variante_id,'toVariantId',p_variant_id));
end $$;

create or replace function public.scan_order_preparation_code(
  p_order_id bigint, p_code text, p_actor_id uuid, p_request_key uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype;
  v_line public.order_preparation_lines%rowtype;
  v_exact public.order_preparation_lines%rowtype;
  v_prior public.order_preparation_scans%rowtype;
  v_target record;
  v_target_product_id bigint;
  v_sku text;
  v_barcode text;
  v_duplicate boolean := false;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or nullif(btrim(coalesce(p_code, '')), '') is null
     or length(btrim(p_code)) > 128 then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  select * into v_prior from public.order_preparation_scans
    where package_id = v_package.id and attempt_number = v_package.attempt_number
      and request_key = p_request_key;
  if found then
    if v_prior.code <> btrim(p_code) then raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    v_duplicate := true;
    select * into v_line from public.order_preparation_lines
      where package_id = v_package.id and order_item_id = v_prior.order_item_id;
  else
    if v_package.status <> 'preparing' then raise exception 'DISPATCH_ALREADY_PREPARED'; end if;
    v_sku := public.normalized_catalog_sku(p_code);
    v_barcode := public.normalized_catalog_barcode(p_code);
    -- 1) Código esperado de un renglón (comportamiento original).
    select * into v_exact from public.order_preparation_lines
      where package_id = v_package.id
        and ((expected_sku is not null and expected_sku = v_sku)
          or (expected_barcode is not null and expected_barcode = v_barcode))
      order by (scanned_quantity < expected_quantity) desc, order_item_id
      limit 1 for update;
    if found and v_exact.scanned_quantity < v_exact.expected_quantity then
      v_line := v_exact;
    else
      select * into v_target from public.catalog_code_target(p_code);
      if found then
        v_target_product_id := v_target.product_id;
        -- 2) Alias de la variante de un renglón pendiente, o código de grupo
        --    de un renglón aleatorio pendiente (conserva la variante asignada).
        select l.* into v_line from public.order_preparation_lines l
          join public.orden_items i on i.id = l.order_item_id
          where l.package_id = v_package.id and l.conditioned_stock_id is null
            and l.product_id = v_target.product_id and l.scanned_quantity < l.expected_quantity
            and ((v_target.variant_id is not null and l.variant_id = v_target.variant_id)
              or (v_target.variant_id is null and (i.random_fulfillment or l.variant_id is null)))
          order by l.order_item_id limit 1 for update of l;
        -- 3) Variante física distinta de un renglón aleatorio pendiente.
        if not found and v_target.variant_id is not null then
          select l.* into v_line from public.order_preparation_lines l
            join public.orden_items i on i.id = l.order_item_id
            where l.package_id = v_package.id and l.product_id = v_target.product_id
              and i.random_fulfillment and l.scanned_quantity = 0 and l.expected_quantity = 1
            order by l.order_item_id limit 1 for update of l;
          if found then
            perform public.assign_random_order_line_variant(
              v_package, p_order_id, v_line.order_item_id, v_target.variant_id, p_actor_id);
            select * into v_line from public.order_preparation_lines
              where package_id = v_package.id and order_item_id = v_line.order_item_id;
          end if;
        end if;
      end if;
    end if;
    -- Sin renglón pendiente: el código exacto de un renglón completo informa
    -- "cantidad completada", igual que antes.
    if v_line.order_item_id is null and v_exact.order_item_id is not null then v_line := v_exact; end if;
    if v_line.order_item_id is null then
      if upper(v_barcode) ~ '^(BX-PKG-|DSP-)' then raise exception 'DISPATCH_CODE_NOT_PRODUCT'; end if;
      if v_target_product_id is not null
         or exists (select 1 from public.catalog_sku_registry where normalized_sku = v_sku) then
        raise exception 'DISPATCH_WRONG_SKU_OR_VARIANT'; end if;
      raise exception 'DISPATCH_CODE_UNKNOWN';
    end if;
    if v_line.scanned_quantity >= v_line.expected_quantity then
      raise exception 'DISPATCH_QUANTITY_EXCEEDED'; end if;
    v_package := public.register_order_preparation_scan(
      v_package, p_order_id, v_line.order_item_id, p_code, p_actor_id, p_request_key);
    select * into v_line from public.order_preparation_lines
      where package_id = v_package.id and order_item_id = v_line.order_item_id;
  end if;
  return jsonb_build_object('packageId', v_package.id, 'status', v_package.status,
    'orderItemId', v_line.order_item_id, 'scanned', v_line.scanned_quantity,
    'expected', v_line.expected_quantity, 'duplicate', v_duplicate);
end $$;

-- 6. Factura: un renglón aleatorio no fija un color que puede cambiar al armar.
create or replace function public.capture_arca_invoice_items()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.invoice_requested_number is null or new.invoice_cae is not null
     or old.invoice_requested_number is not distinct from new.invoice_requested_number then
    return new;
  end if;

  insert into public.arca_invoice_header_snapshots (order_id, fiscal_total)
  values (new.id, coalesce(new.invoice_requested_total, new.total))
  on conflict (order_id) do update
    set fiscal_total = excluded.fiscal_total, captured_at = clock_timestamp();

  insert into public.arca_invoice_item_snapshots
    (order_id, order_item_id, quantity, unit_price, product_name, variant_name)
  select i.orden_id, i.id, i.cantidad, i.precio,
    coalesce(nullif(btrim(p.nombre), ''), 'Producto #' || i.producto_id::text, 'Producto eliminado'),
    case when i.random_fulfillment then 'Color aleatorio'
      else coalesce(nullif(btrim(i.conditioned_name), ''), nullif(btrim(v.nombre), '')) end
  from public.orden_items i
  left join public.productos p on p.id = i.producto_id
  left join public.producto_variantes v on v.id = i.variante_id
  where i.orden_id = new.id
  on conflict (order_id, order_item_id) do update
    set quantity = excluded.quantity,
        unit_price = excluded.unit_price,
        product_name = excluded.product_name,
        variant_name = excluded.variant_name,
        captured_at = clock_timestamp();
  return new;
end;
$$;

revoke all on function public.guard_catalog_barcode_alias(),
  public.guard_catalog_barcode_registry_alias(),
  public.catalog_code_target(text),
  public.register_order_preparation_scan(public.order_packages,bigint,bigint,text,uuid,uuid),
  public.order_preparation_code_matches(public.order_preparation_lines,text),
  public.assign_random_order_line_variant(public.order_packages,bigint,bigint,bigint,uuid),
  public.capture_arca_invoice_items()
  from public, anon, authenticated;
grant execute on function public.catalog_code_target(text) to service_role;

-- Segundo color de una variante bicolor: mismo RPC de metadata (bloqueo por
-- producto y auditoría vía beyonix.actor_id); una clave ausente no lo toca.
create or replace function public.update_product_variant_metadata_atomic(
  p_product_id bigint,
  p_variant_id bigint,
  p_metadata jsonb,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar la variante.';
  end if;
  if jsonb_typeof(coalesce(p_metadata, 'null'::jsonb)) <> 'object' then
    raise exception 'Los datos de la variante no son válidos.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  update public.producto_variantes variants
  set nombre = case when p_metadata ? 'nombre'
        then left(btrim(p_metadata ->> 'nombre'), 160) else variants.nombre end,
      sku = case when p_metadata ? 'sku'
        then nullif(left(btrim(coalesce(p_metadata ->> 'sku', '')), 120), '')
        else variants.sku end,
      color_hex = case when p_metadata ? 'color_hex'
        then upper(p_metadata ->> 'color_hex') else variants.color_hex end,
      color_hex_secundario = case when p_metadata ? 'color_hex_secundario'
        then nullif(upper(btrim(coalesce(p_metadata ->> 'color_hex_secundario', ''))), '')
        else variants.color_hex_secundario end,
      codigo_barra = case when p_metadata ? 'codigo_barra'
        then nullif(left(btrim(coalesce(p_metadata ->> 'codigo_barra', '')), 64), '')
        else variants.codigo_barra end,
      imagenes = case when p_metadata ? 'imagenes'
        then p_metadata -> 'imagenes' else variants.imagenes end,
      orden = case when p_metadata ? 'orden'
        then (p_metadata ->> 'orden')::integer else variants.orden end,
      peso_empaquetado_kg = case when p_metadata ? 'peso_empaquetado_kg'
        then nullif(p_metadata ->> 'peso_empaquetado_kg', '')::numeric
        else variants.peso_empaquetado_kg end,
      alto_paquete_cm = case when p_metadata ? 'alto_paquete_cm'
        then nullif(p_metadata ->> 'alto_paquete_cm', '')::numeric
        else variants.alto_paquete_cm end,
      ancho_paquete_cm = case when p_metadata ? 'ancho_paquete_cm'
        then nullif(p_metadata ->> 'ancho_paquete_cm', '')::numeric
        else variants.ancho_paquete_cm end,
      largo_paquete_cm = case when p_metadata ? 'largo_paquete_cm'
        then nullif(p_metadata ->> 'largo_paquete_cm', '')::numeric
        else variants.largo_paquete_cm end
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id
  returning * into v_variant;

  if not found then
    raise exception 'La variante ya no existe.';
  end if;
  perform public.sync_product_primary_variant_image(p_product_id);
  return v_variant;
end;
$$;


-- Venta con color/modelo aleatorio: flag comercial del producto. Se cambia
-- bajo el mismo bloqueo por producto que las reservas, y sólo un producto con
-- al menos dos variantes físicas puede venderse como aleatorio.
create or replace function public.set_product_random_fulfillment(
  p_product_id bigint,
  p_enabled boolean,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cambiar la venta aleatoria.';
  end if;
  if p_enabled is null then
    raise exception 'RANDOM_FULFILLMENT_INVALID';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  perform set_config('beyonix.actor_id', coalesce(p_actor_id::text, ''), true);

  if p_enabled and (
    select count(*) from public.producto_variantes v where v.producto_id = p_product_id
  ) < 2 then
    raise exception 'RANDOM_FULFILLMENT_NEEDS_VARIANTS';
  end if;

  update public.productos
  set venta_aleatoria = p_enabled
  where id = p_product_id
  returning * into v_product;

  if not found then
    raise exception 'El producto ya no existe.';
  end if;
  return v_product;
end;
$$;

revoke all on function public.set_product_random_fulfillment(bigint, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.set_product_random_fulfillment(bigint, boolean, uuid) to service_role;
