-- Códigos de barra de catálogo, bultos físicos por pedido y escaneo de bultos
-- en el lote de envío. Extiende el modelo de Despachos (20261005100000..130000):
-- order_packages sigue siendo el registro único de armado por pedido; los
-- bultos son filas hijas y el lote (dispatch_batches) sigue siendo la única
-- agrupación. El corte financiero no cambia: dispatch_batches.prepared_at
-- (= closed_at) y order_was_prepared_for_dispatch().
--
-- Stock: nada de esta migración descuenta ni suma stock. El stock se reserva y
-- descuenta en el checkout/confirmación del pedido y se suma en Compras
-- (save_product_purchase_idempotent). El escaneo valida identidad física.

-- 1. Origen del código de barra -------------------------------------------
-- Derivado del propio código (sin estado duplicado que pueda divergir): los
-- códigos internos BEYONIX tienen el formato BX-XXX-NNNNNN; cualquier otro
-- código cargado es del fabricante (EAN/UPC u otro impreso en el envase).
alter table public.producto_variantes
  add column if not exists codigo_barra_origen text
  generated always as (
    case
      when nullif(btrim(coalesce(codigo_barra, '')), '') is null then null
      when btrim(codigo_barra) ~ '^BX-[A-Z]{3}-[0-9]{6,}$' then 'beyonix'
      else 'fabricante'
    end
  ) stored;

alter table public.productos
  add column if not exists codigo_barra_origen text
  generated always as (
    case
      when nullif(btrim(coalesce(codigo_barra, '')), '') is null then null
      when btrim(codigo_barra) ~ '^BX-[A-Z]{3}-[0-9]{6,}$' then 'beyonix'
      else 'fabricante'
    end
  ) stored;

-- Los prefijos de bulto y de lote quedan reservados: un artículo nunca puede
-- confundirse con un bulto o un lote al escanear.
alter table public.producto_variantes
  add constraint producto_variantes_codigo_barra_reserved_check
  check (codigo_barra is null or upper(btrim(codigo_barra)) !~ '^(BX-PKG-|DSP-)') not valid;
alter table public.productos
  add constraint productos_codigo_barra_reserved_check
  check (codigo_barra is null or upper(btrim(codigo_barra)) !~ '^(BX-PKG-|DSP-)') not valid;
do $$
begin
  alter table public.producto_variantes validate constraint producto_variantes_codigo_barra_reserved_check;
  alter table public.productos validate constraint productos_codigo_barra_reserved_check;
exception when check_violation then
  raise notice 'Hay códigos de barra legacy con prefijo reservado; el check queda NOT VALID para filas existentes.';
end $$;

comment on column public.producto_variantes.codigo_barra_origen is
  'fabricante | beyonix, derivado del código. BEYONIX = BX-XXX-NNNNNN generado por generate_beyonix_variant_barcode.';

-- 2. Generador de código interno BEYONIX -----------------------------------
create sequence if not exists public.beyonix_variant_barcode_seq as bigint start 1 minvalue 1;
revoke all on sequence public.beyonix_variant_barcode_seq from public, anon, authenticated;
grant usage on sequence public.beyonix_variant_barcode_seq to service_role;

create or replace function public.beyonix_barcode_prefix(p_name text)
returns text language sql immutable
set search_path = pg_catalog as $$
  select case when length(v) = 3 and v <> 'PKG' then v else 'GEN' end
  from (select left(regexp_replace(upper(translate(coalesce(p_name, ''),
      'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
      'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')), '[^A-Z]', '', 'g'), 3) as v) s
$$;

-- Idempotente: si la variante ya tiene código (de fabricante o BEYONIX) lo
-- devuelve sin tocarlo. Nunca inventa EAN/UPC: el formato interno no es GS1.
create or replace function public.generate_beyonix_variant_barcode(
  p_product_id bigint, p_variant_id bigint, p_actor_id uuid)
returns public.producto_variantes language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_prefix text;
  v_number bigint;
  v_code text;
  v_attempt integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para generar códigos de barra.';
  end if;
  select * into v_variant from public.producto_variantes
    where id = p_variant_id and producto_id = p_product_id for update;
  if not found then raise exception 'La variante ya no existe.'; end if;
  if public.normalized_catalog_barcode(v_variant.codigo_barra) is not null then
    return v_variant;
  end if;
  select public.beyonix_barcode_prefix(nombre) into v_prefix
    from public.productos where id = p_product_id;
  v_prefix := coalesce(v_prefix, 'GEN');
  perform set_config('beyonix.actor_id', coalesce(p_actor_id::text, ''), true);
  loop
    v_attempt := v_attempt + 1;
    v_number := nextval('public.beyonix_variant_barcode_seq');
    v_code := 'BX-' || v_prefix || '-' ||
      case when v_number < 1000000 then lpad(v_number::text, 6, '0') else v_number::text end;
    begin
      update public.producto_variantes set codigo_barra = v_code
        where id = p_variant_id returning * into v_variant;
      exit;
    exception when raise_exception or unique_violation then
      -- Un código cargado a mano con el mismo número: se toma el siguiente.
      if v_attempt >= 10 or sqlerrm not like 'El código de barra % ya está asignado%' then raise; end if;
    end;
  end loop;
  return v_variant;
end $$;

revoke all on function public.beyonix_barcode_prefix(text),
  public.generate_beyonix_variant_barcode(bigint, bigint, uuid) from public, anon, authenticated;
grant execute on function public.beyonix_barcode_prefix(text),
  public.generate_beyonix_variant_barcode(bigint, bigint, uuid) to service_role;

-- 3. Código obligatorio al ACTIVAR -----------------------------------------
-- Mismo criterio que el stock (20261001140000): requisito de activación, no
-- invariante permanente. Las variantes activas legacy sin código siguen
-- vendiéndose y el admin las marca "Código pendiente".
create or replace function public.product_variant_listing_error(
  p_product_id bigint,
  p_variant_id bigint,
  p_primary boolean,
  p_require_stock boolean
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_subject text := case
    when p_primary then 'La variante principal'
    else 'La variante'
  end;
begin
  select * into v_variant
  from public.producto_variantes variants
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id;

  if not found then
    return case
      when p_primary then 'Creá al menos una variante.'
      else 'La variante ya no existe.'
    end;
  end if;
  if nullif(btrim(coalesce(v_variant.nombre, '')), '') is null then
    return v_subject || ' necesita un nombre.';
  end if;
  if nullif(btrim(coalesce(v_variant.sku, '')), '') is null then
    return v_subject || ' necesita un SKU.';
  end if;
  if v_variant.color_hex is null
     or v_variant.color_hex !~ '^#[0-9A-Fa-f]{6}$' then
    return v_subject || ' necesita un color.';
  end if;
  if jsonb_typeof(coalesce(v_variant.imagenes, '[]'::jsonb)) <> 'array' then
    return v_subject || ' necesita al menos una imagen.';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements_text(v_variant.imagenes) images(url)
    where nullif(btrim(images.url), '') is not null
  ) then
    return v_subject || ' necesita al menos una imagen.';
  end if;

  if p_require_stock and public.normalized_catalog_barcode(v_variant.codigo_barra) is null then
    return v_subject || ' necesita un código de barra (de fabricante o BEYONIX).';
  end if;
  if p_require_stock and coalesce(v_variant.stock, 0) <= 0 then
    return v_subject || ' necesita stock asignado.';
  end if;

  return null;
end;
$$;

-- 4. Bultos físicos del pedido ---------------------------------------------
alter table public.order_packages
  add column if not exists parcel_count integer,
  add column if not exists parcels_defined_by uuid,
  add column if not exists parcels_defined_at timestamptz,
  add column if not exists parcels_request_key uuid;
alter table public.order_packages
  add constraint order_packages_parcel_count_check
    check (parcel_count is null or parcel_count between 1 and 50),
  add constraint order_packages_parcels_prepared_check
    check (parcel_count is null or status = 'prepared'),
  add constraint order_packages_parcels_pair_check
    check ((parcel_count is null) = (parcels_defined_at is null)
       and (parcel_count is null) = (parcels_defined_by is null)),
  add constraint order_packages_id_order_unique unique (id, order_id);

-- Cada intento de armado tiene sus propios bultos. Los de intentos anteriores
-- se conservan como historial (y por los escaneos que los referencian).
create table public.order_package_parcels (
  id bigint generated by default as identity primary key,
  package_id bigint not null,
  order_id bigint not null references public.ordenes(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  parcel_index integer not null,
  parcel_count integer not null check (parcel_count between 1 and 50),
  barcode text not null unique check (barcode ~ '^BX-PKG-[0-9]+(-R[0-9]+)?-[0-9]{2}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  check (parcel_index between 1 and parcel_count),
  unique (package_id, attempt_number, parcel_index),
  foreign key (package_id, order_id)
    references public.order_packages(id, order_id) on delete restrict
);
create index order_package_parcels_order_idx on public.order_package_parcels(order_id);

create table public.dispatch_batch_parcel_scans (
  id bigint generated by default as identity primary key,
  batch_id bigint not null references public.dispatch_batches(id) on delete restrict,
  batch_item_id bigint not null references public.dispatch_batch_items(id) on delete restrict,
  parcel_id bigint not null references public.order_package_parcels(id) on delete restrict,
  request_key uuid not null,
  scanned_by uuid not null,
  scanned_at timestamptz not null default now(),
  unique (batch_item_id, parcel_id),
  unique (batch_id, request_key)
);
create index dispatch_batch_parcel_scans_batch_idx on public.dispatch_batch_parcel_scans(batch_id);
create index dispatch_batch_parcel_scans_parcel_idx on public.dispatch_batch_parcel_scans(parcel_id);

alter table public.order_package_parcels enable row level security;
alter table public.dispatch_batch_parcel_scans enable row level security;
revoke all on public.order_package_parcels, public.dispatch_batch_parcel_scans
  from public, anon, authenticated;
grant select on public.order_package_parcels, public.dispatch_batch_parcel_scans
  to service_role, authenticated;
create policy order_package_parcels_internal_read on public.order_package_parcels
  for select to authenticated using (public.is_current_user_internal());
create policy dispatch_batch_parcel_scans_internal_read on public.dispatch_batch_parcel_scans
  for select to authenticated using (public.is_current_user_internal());

do $$
declare v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach v_table in array array['order_package_parcels','dispatch_batch_parcel_scans'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end $$;

-- Reiniciar el armado invalida la definición de bultos del intento anterior.
create or replace function public.clear_package_parcels_on_reset()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.attempt_number <> old.attempt_number or new.status <> 'prepared' then
    new.parcel_count := null;
    new.parcels_defined_at := null;
    new.parcels_defined_by := null;
    new.parcels_request_key := null;
  end if;
  return new;
end $$;
create trigger clear_package_parcels_on_reset before update on public.order_packages
  for each row execute function public.clear_package_parcels_on_reset();

-- Bultos que faltan escanear de un pedido en un lote. -1 = bultos sin definir.
create or replace function public.dispatch_item_missing_parcels(p_batch_item_id bigint)
returns integer language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select case when pk.parcel_count is null then -1
    else pk.parcel_count - (
      select count(distinct s.parcel_id)::integer
      from public.dispatch_batch_parcel_scans s
      join public.order_package_parcels p on p.id = s.parcel_id
      where s.batch_item_id = i.id and p.package_id = pk.id
        and p.attempt_number = pk.attempt_number and p.parcel_count = pk.parcel_count)
    end
  from public.dispatch_batch_items i
  join public.order_packages pk on pk.id = i.package_id
  where i.id = p_batch_item_id
$$;

-- FINALIZAR ARMADO: el operador indica los bultos físicos. No se deriva de las
-- unidades. Idempotente por request_key y por cantidad (doble clic).
create or replace function public.set_order_package_parcels(
  p_order_id bigint, p_parcel_count integer, p_actor_id uuid, p_request_key uuid)
returns public.order_packages language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype;
  v_batch_status text;
  v_base text;
  v_index integer;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null then raise exception 'DISPATCH_REQUEST_KEY_REQUIRED'; end if;
  if p_parcel_count is null or p_parcel_count < 1 or p_parcel_count > 50 then
    raise exception 'DISPATCH_PARCEL_COUNT_INVALID'; end if;
  perform 1 from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  if v_package.parcels_request_key = p_request_key then
    if v_package.parcel_count = p_parcel_count then return v_package; end if;
    raise exception 'DISPATCH_SCAN_KEY_CONFLICT';
  end if;
  if v_package.status <> 'prepared' then raise exception 'DISPATCH_PACKAGE_NOT_PREPARED'; end if;
  if v_package.parcel_count = p_parcel_count then return v_package; end if;
  if exists (select 1 from public.ordenes where id = p_order_id and andreani_handed_over_at is not null) then
    raise exception 'DISPATCH_ALREADY_HANDED_OVER'; end if;
  select b.status into v_batch_status
    from public.dispatch_batch_items i join public.dispatch_batches b on b.id = i.batch_id
    where i.order_id = p_order_id and i.removed_at is null;
  if v_batch_status in ('closed', 'handed_over') then raise exception 'DISPATCH_PARCELS_LOCKED'; end if;
  if exists (select 1 from public.dispatch_batch_parcel_scans s
             join public.order_package_parcels p on p.id = s.parcel_id
             where p.package_id = v_package.id and p.attempt_number = v_package.attempt_number) then
    raise exception 'DISPATCH_PARCELS_LOCKED'; end if;
  if exists (select 1 from unnest(public.dispatch_order_block_reasons(p_order_id)) r
             where r not in ('invoice_pending', 'shipment_pending'))
     or exists (select 1 from public.dispatch_blocks where order_id = p_order_id
                and source = 'manual' and resolved_at is null) then
    raise exception 'DISPATCH_ORDER_BLOCKED'; end if;

  -- Sin escaneos: las etiquetas anteriores de este intento todavía no salieron.
  delete from public.order_package_parcels
    where package_id = v_package.id and attempt_number = v_package.attempt_number;
  v_base := 'BX-PKG-' || (1000 + p_order_id)::text ||
    case when v_package.attempt_number > 1 then '-R' || v_package.attempt_number::text else '' end;
  for v_index in 1..p_parcel_count loop
    insert into public.order_package_parcels
      (package_id, order_id, attempt_number, parcel_index, parcel_count, barcode, created_by)
    values (v_package.id, p_order_id, v_package.attempt_number, v_index, p_parcel_count,
      v_base || '-' || lpad(v_index::text, 2, '0'), p_actor_id);
  end loop;
  update public.order_packages set parcel_count = p_parcel_count, parcels_defined_at = now(),
    parcels_defined_by = p_actor_id, parcels_request_key = p_request_key
    where id = v_package.id returning * into v_package;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_parcels_defined',
      jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
        'parcelCount', p_parcel_count));
  return v_package;
end $$;

-- 5. Armado por código: el servidor resuelve la línea --------------------
-- Reutiliza scan_order_preparation_item (misma validación, mismo registro de
-- escaneo idempotente y mismo cierre automático a 'prepared').
create or replace function public.scan_order_preparation_code(
  p_order_id bigint, p_code text, p_actor_id uuid, p_request_key uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype;
  v_line public.order_preparation_lines%rowtype;
  v_prior public.order_preparation_scans%rowtype;
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
    select * into v_line from public.order_preparation_lines
      where package_id = v_package.id
        and ((expected_sku is not null and expected_sku = v_sku)
          or (expected_barcode is not null and expected_barcode = v_barcode))
      order by (scanned_quantity < expected_quantity) desc, order_item_id
      limit 1 for update;
    if not found then
      if upper(v_barcode) ~ '^(BX-PKG-|DSP-)' then raise exception 'DISPATCH_CODE_NOT_PRODUCT'; end if;
      if exists (select 1 from public.catalog_barcode_registry where normalized_barcode = v_barcode)
         or exists (select 1 from public.catalog_sku_registry where normalized_sku = v_sku) then
        raise exception 'DISPATCH_WRONG_SKU_OR_VARIANT'; end if;
      raise exception 'DISPATCH_CODE_UNKNOWN';
    end if;
    if v_line.scanned_quantity >= v_line.expected_quantity then
      raise exception 'DISPATCH_QUANTITY_EXCEEDED'; end if;
    v_package := public.scan_order_preparation_item(
      p_order_id, v_line.order_item_id, p_code, p_actor_id, p_request_key);
    select * into v_line from public.order_preparation_lines
      where package_id = v_package.id and order_item_id = v_line.order_item_id;
  end if;
  return jsonb_build_object('packageId', v_package.id, 'status', v_package.status,
    'orderItemId', v_line.order_item_id, 'scanned', v_line.scanned_quantity,
    'expected', v_line.expected_quantity, 'duplicate', v_duplicate);
end $$;

-- 6. Lote: sólo pedidos completos con bultos definidos ---------------------
create or replace function public.add_order_to_dispatch_batch(p_batch_id bigint,p_order_id bigint,p_actor_id uuid)
returns public.dispatch_batch_items language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_package public.order_packages%rowtype;
  v_item public.dispatch_batch_items%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  select * into v_item from public.dispatch_batch_items
    where batch_id = p_batch_id and order_id = p_order_id and removed_at is null;
  if found then return v_item; end if;
  if v_batch.status <> 'open' then raise exception 'DISPATCH_BATCH_CLOSED'; end if;
  perform 1 from public.ordenes where id = p_order_id for update;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found or v_package.status <> 'prepared' then
    raise exception 'DISPATCH_PACKAGE_NOT_PREPARED' using detail = p_order_id::text; end if;
  if v_package.parcel_count is null then
    raise exception 'DISPATCH_PARCELS_PENDING' using detail = p_order_id::text; end if;
  if cardinality(public.dispatch_order_block_reasons(p_order_id)) > 0
     or exists (select 1 from public.dispatch_blocks where order_id = p_order_id and resolved_at is null)
     then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = p_order_id::text; end if;
  insert into public.dispatch_batch_items(batch_id,package_id,order_id,added_by)
    values (p_batch_id,v_package.id,p_order_id,p_actor_id) returning * into v_item;
  insert into public.dispatch_batch_events(batch_id,actor_id,action,order_id)
    values (p_batch_id,p_actor_id,'order_added',p_order_id);
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,metadata)
    values (p_order_id,'admin',p_actor_id,'order_added_to_dispatch_batch',jsonb_build_object('batchId',p_batch_id));
  return v_item;
end $$;

-- CREAR LOTE DE ENVÍO con los pedidos seleccionados: todo o nada.
create or replace function public.create_dispatch_batch_with_orders(
  p_actor_id uuid, p_request_key uuid, p_order_ids bigint[])
returns public.dispatch_batches language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_order_id bigint; v_message text;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if coalesce(cardinality(p_order_ids), 0) = 0 then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  v_batch := public.create_dispatch_batch(p_actor_id, p_request_key);
  for v_order_id in select distinct unnest(p_order_ids) order by 1 loop
    begin
      perform public.add_order_to_dispatch_batch(v_batch.id, v_order_id, p_actor_id);
    exception when others then
      get stacked diagnostics v_message = message_text;
      raise exception '%', v_message using detail = v_order_id::text;
    end;
  end loop;
  return v_batch;
end $$;

-- ESCANEAR BULTO en el lote. Si el pedido completo todavía no está en ningún
-- lote, lo agrega (mismas validaciones que add_order_to_dispatch_batch).
create or replace function public.scan_dispatch_parcel(
  p_batch_id bigint, p_code text, p_actor_id uuid, p_request_key uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_batch public.dispatch_batches%rowtype;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_parcel public.order_package_parcels%rowtype;
  v_package public.order_packages%rowtype;
  v_item public.dispatch_batch_items%rowtype;
  v_prior public.dispatch_batch_parcel_scans%rowtype;
  v_other_code text;
  v_duplicate boolean := false;
  v_missing integer;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or v_code = '' or length(v_code) > 64 then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  select * into v_prior from public.dispatch_batch_parcel_scans
    where batch_id = p_batch_id and request_key = p_request_key;
  if found then
    select * into v_parcel from public.order_package_parcels where id = v_prior.parcel_id;
    if v_parcel.barcode <> v_code then raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    select * into v_item from public.dispatch_batch_items where id = v_prior.batch_item_id;
    v_duplicate := true;
  else
    if v_batch.status <> 'open' then raise exception 'DISPATCH_BATCH_CLOSED'; end if;
    select * into v_parcel from public.order_package_parcels where barcode = v_code;
    if not found then
      if v_code ~ '^DSP-' then raise exception 'DISPATCH_CODE_IS_BATCH'; end if;
      if v_code ~ '^BX-PKG-' then raise exception 'DISPATCH_PARCEL_UNKNOWN'; end if;
      if exists (select 1 from public.catalog_barcode_registry
                 where normalized_barcode = public.normalized_catalog_barcode(p_code))
         or exists (select 1 from public.catalog_sku_registry
                    where normalized_sku = public.normalized_catalog_sku(p_code)) then
        raise exception 'DISPATCH_CODE_IS_PRODUCT'; end if;
      raise exception 'DISPATCH_CODE_UNKNOWN';
    end if;
    perform 1 from public.ordenes where id = v_parcel.order_id for update;
    select * into v_package from public.order_packages where id = v_parcel.package_id for update;
    if v_package.attempt_number <> v_parcel.attempt_number
       or v_package.parcel_count is distinct from v_parcel.parcel_count then
      raise exception 'DISPATCH_PARCEL_STALE' using detail = v_parcel.order_id::text; end if;
    select * into v_item from public.dispatch_batch_items
      where order_id = v_parcel.order_id and removed_at is null;
    if found and v_item.batch_id <> p_batch_id then
      select code into v_other_code from public.dispatch_batches where id = v_item.batch_id;
      raise exception 'DISPATCH_PARCEL_OTHER_BATCH' using detail = coalesce(v_other_code, '');
    end if;
    if not found then
      v_item := public.add_order_to_dispatch_batch(p_batch_id, v_parcel.order_id, p_actor_id);
    elsif cardinality(public.dispatch_order_block_reasons(v_parcel.order_id)) > 0
       or exists (select 1 from public.dispatch_blocks
                  where order_id = v_parcel.order_id and resolved_at is null) then
      raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_parcel.order_id::text;
    end if;
    insert into public.dispatch_batch_parcel_scans(batch_id, batch_item_id, parcel_id, request_key, scanned_by)
      values (p_batch_id, v_item.id, v_parcel.id, p_request_key, p_actor_id)
      on conflict (batch_item_id, parcel_id) do nothing;
    v_duplicate := not found;
  end if;
  v_missing := public.dispatch_item_missing_parcels(v_item.id);
  return jsonb_build_object('orderId', v_parcel.order_id, 'batchItemId', v_item.id,
    'parcelId', v_parcel.id, 'barcode', v_parcel.barcode,
    'parcelIndex', v_parcel.parcel_index, 'parcelCount', v_parcel.parcel_count,
    'scannedCount', v_parcel.parcel_count - greatest(v_missing, 0),
    'complete', v_missing = 0, 'duplicate', v_duplicate, 'batchCode', v_batch.code);
end $$;

-- CERRAR LOTE: revalida todo en el backend, incluidos todos los bultos.
create or replace function public.close_dispatch_batch(p_batch_id bigint,p_actor_id uuid)
returns public.dispatch_batches language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_item record;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status in ('closed','handed_over') then return v_batch; end if;
  if not exists (select 1 from public.dispatch_batch_items where batch_id = p_batch_id and removed_at is null)
     then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  for v_item in select id, order_id, package_id from public.dispatch_batch_items
    where batch_id = p_batch_id and removed_at is null order by order_id loop
    perform 1 from public.ordenes where id = v_item.order_id for update;
    if cardinality(public.dispatch_order_block_reasons(v_item.order_id)) > 0
       or exists (select 1 from public.dispatch_blocks where order_id = v_item.order_id and resolved_at is null)
       or not exists (select 1 from public.order_packages
                      where id = v_item.package_id and order_id = v_item.order_id and status = 'prepared')
       then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_item.order_id::text; end if;
    if public.dispatch_item_missing_parcels(v_item.id) <> 0 then
      raise exception 'DISPATCH_PARCELS_MISSING' using detail = v_item.order_id::text; end if;
  end loop;
  update public.dispatch_batches set status='closed',closed_at=now(),closed_by=p_actor_id
    where id=p_batch_id returning * into v_batch;
  insert into public.dispatch_batch_events(batch_id,actor_id,action)
    values (p_batch_id,p_actor_id,'closed');
  return v_batch;
end $$;

create or replace function public.hand_over_dispatch_batch(p_batch_id bigint,p_actor_id uuid)
returns public.dispatch_batches language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_item record; v_at timestamptz := now();
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id=p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status='handed_over' then return v_batch; end if;
  if v_batch.status<>'closed' then raise exception 'DISPATCH_BATCH_NOT_CLOSED'; end if;
  if not exists (select 1 from public.dispatch_batch_items where batch_id=p_batch_id and removed_at is null)
     then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  -- Lock every order before checking. Cancellation and refund RPCs lock the same rows.
  for v_item in select i.id,i.order_id,i.package_id from public.dispatch_batch_items i
    where i.batch_id=p_batch_id and i.removed_at is null order by i.order_id loop
    perform 1 from public.ordenes where id=v_item.order_id for update;
    if cardinality(public.dispatch_order_block_reasons(v_item.order_id))>0
       or exists (select 1 from public.dispatch_blocks where order_id=v_item.order_id and resolved_at is null)
       or not exists (select 1 from public.order_packages
                      where id=v_item.package_id and order_id=v_item.order_id and status='prepared')
       then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_item.order_id::text; end if;
    if public.dispatch_item_missing_parcels(v_item.id) <> 0 then
      raise exception 'DISPATCH_PARCELS_MISSING' using detail = v_item.order_id::text; end if;
  end loop;
  update public.dispatch_batches set status='handed_over',handed_over_by=p_actor_id,
    handed_over_at=v_at where id=p_batch_id returning * into v_batch;
  insert into public.dispatch_batch_events(batch_id,actor_id,action)
    values (p_batch_id,p_actor_id,'handed_over');
  for v_item in select order_id from public.dispatch_batch_items
    where batch_id=p_batch_id and removed_at is null order by order_id loop
    update public.ordenes set andreani_handed_over_at=v_at,
      andreani_handed_over_by=p_actor_id,andreani_handed_over_batch_id=p_batch_id
      where id=v_item.order_id and andreani_handed_over_at is null;
    if not found then raise exception 'DISPATCH_ORDER_ALREADY_HANDED_OVER'; end if;
    insert into public.order_audit_events(order_id,actor_type,actor_id,action,metadata)
      values (v_item.order_id,'admin',p_actor_id,'order_handed_over_to_andreani',
        jsonb_build_object('batchId',p_batch_id,'batchCode',v_batch.code));
  end loop;
  return v_batch;
end $$;

revoke all on function public.clear_package_parcels_on_reset(),
  public.dispatch_item_missing_parcels(bigint),
  public.set_order_package_parcels(bigint,integer,uuid,uuid),
  public.scan_order_preparation_code(bigint,text,uuid,uuid),
  public.create_dispatch_batch_with_orders(uuid,uuid,bigint[]),
  public.scan_dispatch_parcel(bigint,text,uuid,uuid),
  public.add_order_to_dispatch_batch(bigint,bigint,uuid),
  public.close_dispatch_batch(bigint,uuid),
  public.hand_over_dispatch_batch(bigint,uuid) from public,anon,authenticated;
grant execute on function public.dispatch_item_missing_parcels(bigint),
  public.set_order_package_parcels(bigint,integer,uuid,uuid),
  public.scan_order_preparation_code(bigint,text,uuid,uuid),
  public.create_dispatch_batch_with_orders(uuid,uuid,bigint[]),
  public.scan_dispatch_parcel(bigint,text,uuid,uuid),
  public.add_order_to_dispatch_batch(bigint,bigint,uuid),
  public.close_dispatch_batch(bigint,uuid),
  public.hand_over_dispatch_batch(bigint,uuid) to service_role;
