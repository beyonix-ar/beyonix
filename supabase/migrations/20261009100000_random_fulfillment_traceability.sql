-- Venta aleatoria: trazabilidad física exacta.
--
-- Modelo (no cambia el ledger de inventario):
--   * orden_items.reserved_variant_id: variante que la reserva del checkout
--     asignó. Inmutable; sólo garantiza stock y queda como referencia.
--   * orden_items.variante_id: variante que HOY consume stock (el ledger
--     inventory_movements deriva la venta web de esta columna). El armado la
--     cambia a la variante física escaneada, de forma atómica: el mismo UPDATE
--     devuelve la unidad a la variante anterior y la consume de la nueva
--     (trigger refresh_inventory_after_order_item, bajo el lock por producto).
--   * order_preparation_scans.physical_variant_id: variante física registrada
--     por cada escaneo, por intento de armado (R1, R2...). Es el histórico de
--     "qué salió" y nunca se pisa al rearmar.
--
-- Un código de grupo (EAN común, SKU del producto) NO identifica la variante:
-- en un renglón aleatorio el escaneo no se registra hasta que el operador
-- confirma qué variante física tiene en mano (p_variant_id).

-- 1. Variante reservada ---------------------------------------------------------
-- Sin FK a propósito: es una referencia histórica (la fija la base a partir de
-- variante_id, que sí está validada) y una segunda FK orden_items →
-- producto_variantes volvería ambiguos los embeds PostgREST existentes
-- (orden_items?select=producto_variantes(...)).
alter table public.orden_items
  add column if not exists reserved_variant_id bigint;
comment on column public.orden_items.reserved_variant_id is
  'Venta aleatoria: variante asignada por la reserva del checkout. Inmutable (referencia histórica, sin FK). La variante física despachada es variante_id una vez armado (ver order_preparation_scans.physical_variant_id).';

-- Las órdenes previas sólo pudieron cambiar de variante en el armado, que dejó
-- la variante original en el evento random_variant_assigned.
update public.orden_items items
set reserved_variant_id = coalesce((
    select (events.metadata ->> 'fromVariantId')::bigint
    from public.order_audit_events events
    where events.order_id = items.orden_id
      and events.action = 'random_variant_assigned'
      and events.metadata ->> 'orderItemId' = items.id::text
    order by events.created_at, events.id
    limit 1
  ), items.variante_id)
where items.random_fulfillment and items.reserved_variant_id is null;

alter table public.orden_items
  add constraint orden_items_reserved_variant_random_check
    check (reserved_variant_id is null or random_fulfillment);

-- La reserva la fija la base al insertar (nunca el navegador) y no cambia.
create or replace function public.guard_order_item_reserved_variant()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.reserved_variant_id := case when new.random_fulfillment then new.variante_id end;
    return new;
  end if;
  if new.reserved_variant_id is distinct from old.reserved_variant_id then
    raise exception 'ORDER_ITEM_RESERVED_VARIANT_IMMUTABLE';
  end if;
  return new;
end $$;
drop trigger if exists guard_order_item_reserved_variant on public.orden_items;
create trigger guard_order_item_reserved_variant
  before insert or update of reserved_variant_id on public.orden_items
  for each row execute function public.guard_order_item_reserved_variant();

-- 2. Variante física por escaneo ------------------------------------------------
alter table public.order_preparation_scans
  add column if not exists physical_variant_id bigint
    references public.producto_variantes(id) on delete set null,
  add column if not exists variant_identification text,
  -- Histórico sin FK (misma razón que reserved_variant_id).
  add column if not exists reassigned_from_variant_id bigint;
alter table public.order_preparation_scans
  add constraint order_preparation_scans_variant_identification_check
    check (variant_identification is null
      or variant_identification in ('variant_code', 'group_confirmed'));
create index if not exists order_preparation_scans_item_idx
  on public.order_preparation_scans(order_item_id, attempt_number);
comment on column public.order_preparation_scans.physical_variant_id is
  'Variante física registrada por este escaneo (histórico por intento de armado).';
comment on column public.order_preparation_scans.variant_identification is
  'variant_code: el código identifica la variante. group_confirmed: código de grupo + variante confirmada por el operador.';

-- 3. Registro común de un escaneo válido -----------------------------------------
drop function if exists public.register_order_preparation_scan(
  public.order_packages, bigint, bigint, text, uuid, uuid);
create or replace function public.register_order_preparation_scan(
  p_package public.order_packages, p_order_id bigint, p_order_item_id bigint,
  p_code text, p_actor_id uuid, p_request_key uuid,
  p_physical_variant_id bigint, p_identification text, p_reassigned_from bigint)
returns public.order_packages language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype := p_package;
  v_item public.orden_items%rowtype;
begin
  update public.order_preparation_lines set scanned_quantity = scanned_quantity + 1
    where package_id = v_package.id and order_item_id = p_order_item_id;
  insert into public.order_preparation_scans(package_id, attempt_number, order_item_id, request_key,
      code, scanned_by, physical_variant_id, variant_identification, reassigned_from_variant_id)
    values (v_package.id, v_package.attempt_number, p_order_item_id, p_request_key,
      btrim(p_code), p_actor_id, p_physical_variant_id, p_identification, p_reassigned_from);
  select * into v_item from public.orden_items where id = p_order_item_id;
  if v_item.random_fulfillment then
    insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
      values (p_order_id, 'admin', p_actor_id, 'random_variant_dispatched', jsonb_build_object(
        'orderItemId', p_order_item_id, 'attempt', v_package.attempt_number,
        'reservedVariantId', v_item.reserved_variant_id,
        'dispatchedVariantId', p_physical_variant_id,
        'reassigned', p_reassigned_from is not null,
        'reassignedFromVariantId', p_reassigned_from,
        'identification', p_identification, 'code', left(btrim(p_code), 128)));
  end if;
  if not exists (select 1 from public.order_preparation_lines
                 where package_id = v_package.id and scanned_quantity <> expected_quantity) then
    update public.order_packages set status = 'prepared', prepared_at = now(), prepared_by = p_actor_id
      where id = v_package.id returning * into v_package;
    insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
      values (p_order_id, 'admin', p_actor_id, 'order_prepared', jsonb_build_object('packageId', v_package.id));
  end if;
  return v_package;
end $$;

-- 4. ¿El código identifica el renglón? -------------------------------------------
-- Un código de grupo ya no alcanza para un renglón aleatorio: se rechaza acá y
-- el armado lo resuelve con confirmación explícita (scan_order_preparation_code).
create or replace function public.order_preparation_code_matches(
  p_line public.order_preparation_lines, p_code text)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_target record;
begin
  if (p_line.expected_sku is not null and p_line.expected_sku = public.normalized_catalog_sku(p_code))
     or (p_line.expected_barcode is not null and p_line.expected_barcode = public.normalized_catalog_barcode(p_code)) then
    return true;
  end if;
  if p_line.conditioned_stock_id is not null then return false; end if;
  select * into v_target from public.catalog_code_target(p_code);
  if not found or v_target.product_id is distinct from p_line.product_id then return false; end if;
  if v_target.variant_id is not null then return v_target.variant_id = p_line.variant_id; end if;
  -- Código del grupo: sólo identifica un producto sin variantes.
  return p_line.variant_id is null;
end $$;

-- Camino legado por renglón (sin uso en la app): mismo registro con variante.
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
  return public.register_order_preparation_scan(v_package, p_order_id, p_order_item_id, p_code,
    p_actor_id, p_request_key, v_line.variant_id,
    case when v_line.variant_id is not null then 'variant_code' end, null);
end $$;

-- 5. Reasignación de la variante física (atómica) ---------------------------------
-- Bajo el lock por producto (93000) que comparten reservas y refresh de stock:
-- la variante nueva necesita una unidad LIBRE (stock derivado menos reservas
-- vigentes de checkout). Una unidad ya vendida a otro pedido no está en el
-- stock derivado, así que nunca se "toma prestada". El UPDATE de variante_id
-- recalcula el stock de ambas variantes en la misma transacción.
drop function if exists public.assign_random_order_line_variant(
  public.order_packages, bigint, bigint, bigint, uuid);
create or replace function public.assign_random_order_line_variant(
  p_package public.order_packages, p_order_id bigint, p_order_item_id bigint,
  p_variant_id bigint, p_actor_id uuid, p_code text)
returns bigint language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_item public.orden_items%rowtype; v_variant public.producto_variantes%rowtype;
begin
  select * into v_item from public.orden_items where id = p_order_item_id and orden_id = p_order_id for update;
  if not found or not v_item.random_fulfillment or v_item.cantidad <> 1 then
    raise exception 'DISPATCH_WRONG_SKU_OR_VARIANT'; end if;
  if v_item.variante_id = p_variant_id then return null; end if;
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
      jsonb_build_object('orderItemId',p_order_item_id,'fromVariantId',v_item.variante_id,
        'toVariantId',p_variant_id,'reservedVariantId',v_item.reserved_variant_id,
        'attempt',p_package.attempt_number,'code',left(btrim(p_code),128)));
  return v_item.variante_id;
end $$;

-- 6. Escaneo de ARMAR PEDIDO --------------------------------------------------------
drop function if exists public.scan_order_preparation_code(bigint, text, uuid, uuid);
create or replace function public.scan_order_preparation_code(
  p_order_id bigint, p_code text, p_actor_id uuid, p_request_key uuid,
  p_variant_id bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype;
  v_line public.order_preparation_lines%rowtype;
  v_exact public.order_preparation_lines%rowtype;
  v_prior public.order_preparation_scans%rowtype;
  v_target record;
  v_target_product_id bigint;
  v_physical_variant_id bigint;
  v_identification text;
  v_reassigned_from bigint;
  v_sku text;
  v_barcode text;
  v_duplicate boolean := false;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or nullif(btrim(coalesce(p_code, '')), '') is null
     or length(btrim(p_code)) > 128 or (p_variant_id is not null and p_variant_id <= 0) then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  select * into v_prior from public.order_preparation_scans
    where package_id = v_package.id and attempt_number = v_package.attempt_number
      and request_key = p_request_key;
  if found then
    -- Reintento: mismo código y, si se confirmó variante, la misma variante.
    if v_prior.code <> btrim(p_code)
       or (p_variant_id is not null and v_prior.physical_variant_id is distinct from p_variant_id) then
      raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    v_duplicate := true;
    select * into v_line from public.order_preparation_lines
      where package_id = v_package.id and order_item_id = v_prior.order_item_id;
  else
    if v_package.status <> 'preparing' then raise exception 'DISPATCH_ALREADY_PREPARED'; end if;
    v_sku := public.normalized_catalog_sku(p_code);
    v_barcode := public.normalized_catalog_barcode(p_code);
    if p_variant_id is null then
      -- 1) Código esperado de un renglón: identifica su variante.
      select * into v_exact from public.order_preparation_lines
        where package_id = v_package.id
          and ((expected_sku is not null and expected_sku = v_sku)
            or (expected_barcode is not null and expected_barcode = v_barcode))
        order by (scanned_quantity < expected_quantity) desc, order_item_id
        limit 1 for update;
      if found and v_exact.scanned_quantity < v_exact.expected_quantity then
        v_line := v_exact;
        v_physical_variant_id := v_line.variant_id;
      end if;
    end if;
    if v_line.order_item_id is null then
      select * into v_target from public.catalog_code_target(p_code);
      if found then
        v_target_product_id := v_target.product_id;
        if p_variant_id is not null then
          -- Confirmación explícita: el código debe ser del grupo o de esa misma variante.
          if v_target.variant_id is not null and v_target.variant_id <> p_variant_id then
            raise exception 'DISPATCH_VARIANT_CONFIRMATION_MISMATCH'; end if;
          if not exists (select 1 from public.producto_variantes
                         where id = p_variant_id and producto_id = v_target.product_id and activo) then
            raise exception 'DISPATCH_WRONG_SKU_OR_VARIANT'; end if;
          v_physical_variant_id := p_variant_id;
          v_identification := case when v_target.variant_id is null then 'group_confirmed' else 'variant_code' end;
        elsif v_target.variant_id is not null then
          v_physical_variant_id := v_target.variant_id;
        end if;

        if v_physical_variant_id is not null then
          -- 2) Renglón pendiente que ya tiene esa variante. Una confirmación
          --    manual sólo vale para renglones aleatorios: un pedido normal
          --    sigue exigiendo un código que identifique la variante.
          select l.* into v_line from public.order_preparation_lines l
            join public.orden_items i on i.id = l.order_item_id
            where l.package_id = v_package.id and l.conditioned_stock_id is null
              and l.product_id = v_target.product_id and l.scanned_quantity < l.expected_quantity
              and l.variant_id = v_physical_variant_id
              and (v_identification is distinct from 'group_confirmed' or i.random_fulfillment)
            order by l.order_item_id limit 1 for update of l;
          -- 3) Renglón aleatorio pendiente: se reasigna a la variante física.
          if not found then
            select l.* into v_line from public.order_preparation_lines l
              join public.orden_items i on i.id = l.order_item_id
              where l.package_id = v_package.id and l.product_id = v_target.product_id
                and i.random_fulfillment and l.scanned_quantity = 0 and l.expected_quantity = 1
              order by l.order_item_id limit 1 for update of l;
            if found then
              v_reassigned_from := public.assign_random_order_line_variant(
                v_package, p_order_id, v_line.order_item_id, v_physical_variant_id, p_actor_id, p_code);
              select * into v_line from public.order_preparation_lines
                where package_id = v_package.id and order_item_id = v_line.order_item_id;
            end if;
          end if;
        else
          -- Código de grupo sin confirmación. Un renglón aleatorio pendiente
          -- exige elegir la variante física: no se registra nada todavía.
          if exists (select 1 from public.order_preparation_lines l
                     join public.orden_items i on i.id = l.order_item_id
                     where l.package_id = v_package.id and l.product_id = v_target.product_id
                       and i.random_fulfillment and l.scanned_quantity < l.expected_quantity) then
            return jsonb_build_object('packageId', v_package.id, 'status', v_package.status,
              'requiresVariant', true, 'productId', v_target.product_id,
              'productName', (select nombre from public.productos where id = v_target.product_id),
              'candidates', coalesce((
                select jsonb_agg(jsonb_build_object(
                    'variantId', v.id, 'name', v.nombre, 'colorHex', v.color_hex,
                    'colorHexSecondary', v.color_hex_secundario,
                    'assigned', assigned.variant_id is not null,
                    'selectable', assigned.variant_id is not null
                      or coalesce(public.available_stock_for_session(v.producto_id, v.id, null, null), 0) >= 1)
                  order by assigned.variant_id is null, v.orden nulls last, v.id)
                from public.producto_variantes v
                left join lateral (
                  select l.variant_id from public.order_preparation_lines l
                  join public.orden_items i on i.id = l.order_item_id
                  where l.package_id = v_package.id and l.variant_id = v.id
                    and i.random_fulfillment and l.scanned_quantity < l.expected_quantity
                  limit 1) assigned on true
                where v.producto_id = v_target.product_id and v.activo), '[]'::jsonb));
          end if;
          -- Producto sin variantes: el código del grupo lo identifica.
          select l.* into v_line from public.order_preparation_lines l
            where l.package_id = v_package.id and l.conditioned_stock_id is null
              and l.product_id = v_target.product_id and l.variant_id is null
              and l.scanned_quantity < l.expected_quantity
            order by l.order_item_id limit 1 for update of l;
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
    v_physical_variant_id := coalesce(v_physical_variant_id, v_line.variant_id);
    if v_physical_variant_id is not null then
      v_identification := coalesce(v_identification, 'variant_code');
    end if;
    v_package := public.register_order_preparation_scan(
      v_package, p_order_id, v_line.order_item_id, p_code, p_actor_id, p_request_key,
      v_physical_variant_id, v_identification, v_reassigned_from);
    select * into v_line from public.order_preparation_lines
      where package_id = v_package.id and order_item_id = v_line.order_item_id;
  end if;
  return jsonb_build_object('packageId', v_package.id, 'status', v_package.status,
    'orderItemId', v_line.order_item_id, 'scanned', v_line.scanned_quantity,
    'expected', v_line.expected_quantity, 'duplicate', v_duplicate, 'requiresVariant', false);
end $$;

revoke all on function public.guard_order_item_reserved_variant(),
  public.register_order_preparation_scan(public.order_packages,bigint,bigint,text,uuid,uuid,bigint,text,bigint),
  public.order_preparation_code_matches(public.order_preparation_lines,text),
  public.scan_order_preparation_item(bigint,bigint,text,uuid,uuid),
  public.assign_random_order_line_variant(public.order_packages,bigint,bigint,bigint,uuid,text),
  public.scan_order_preparation_code(bigint,text,uuid,uuid,bigint)
  from public, anon, authenticated;
grant execute on function public.scan_order_preparation_code(bigint,text,uuid,uuid,bigint),
  public.scan_order_preparation_item(bigint,bigint,text,uuid,uuid)
  to service_role;

-- Higiene: funciones de trigger del registro de códigos sin EXECUTE público.
revoke all on function public.sync_product_catalog_barcode_registry(),
  public.sync_variant_catalog_barcode_registry()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
