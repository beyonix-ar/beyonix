-- Importación de ventas de Mercado Libre: modo histórico sin stock y
-- vinculación explícita de SKU históricos / publicación + variante.
--
-- 1. Modo de importación por lote. 'historical' registra ventas que el stock
--    actual ya refleja: nunca descuentan stock ni crean reservas. 'current'
--    es el comportamiento anterior (la venta vinculada descuenta stock). Los
--    lotes existentes quedan como 'current' porque ya descontaron.
-- 2. mercadolibre_sales.stock_effect ('consume' | 'none') es la fuente de
--    verdad de cada venta. Se fija al crearla y no se puede cambiar. Un trigger
--    lo refleja en raw_data.beyonix_stock_effect para que
--    inventory_ml_stock_units (la única función que decide cuántas unidades
--    de una venta ML salen del libro de inventario) lo respete en todas las
--    vistas y guardas existentes sin redefinirlas.
-- 3. Una venta histórica no admite revisión física de devolución: el stock
--    actual ya refleja lo que haya vuelto.
-- 4. product_channel_mappings: vínculos explícitos y auditables de un SKU
--    histórico/alias o de una publicación + variante con un producto/variante
--    actual. Nunca hay coincidencia aproximada por título.

-- 1. Modo del lote -------------------------------------------------------------

alter table public.mercadolibre_import_batches
  add column if not exists import_mode text not null default 'current';

alter table public.mercadolibre_import_batches
  drop constraint if exists mercadolibre_import_batches_import_mode_check;
alter table public.mercadolibre_import_batches
  add constraint mercadolibre_import_batches_import_mode_check
  check (import_mode in ('historical', 'current'));

comment on column public.mercadolibre_import_batches.import_mode is
  'historical: ventas pasadas que el stock actual ya refleja (no mueven stock). current: ventas que descuentan stock al vincularse.';

create or replace function public.guard_mercadolibre_import_batch_mode()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.import_mode is distinct from old.import_mode then
    raise exception 'ML_IMPORT_MODE_IMMUTABLE: el modo de una importación no se puede cambiar.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_mercadolibre_import_batch_mode on public.mercadolibre_import_batches;
create trigger guard_mercadolibre_import_batch_mode
  before update of import_mode on public.mercadolibre_import_batches
  for each row execute function public.guard_mercadolibre_import_batch_mode();

-- 2. Efecto de cada venta sobre el stock -----------------------------------------

alter table public.mercadolibre_sales
  add column if not exists stock_effect text not null default 'consume';

alter table public.mercadolibre_sales
  drop constraint if exists mercadolibre_sales_stock_effect_check;
alter table public.mercadolibre_sales
  add constraint mercadolibre_sales_stock_effect_check
  check (stock_effect in ('consume', 'none'));

comment on column public.mercadolibre_sales.stock_effect is
  'consume: la venta vinculada descuenta stock. none: venta histórica, nunca toca el stock actual. Inmutable.';

create or replace function public.mercadolibre_sale_sync_stock_effect()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.stock_effect is distinct from old.stock_effect then
    raise exception 'ML_SALE_STOCK_EFFECT_IMMUTABLE: el efecto sobre el stock de una venta de Mercado Libre no se puede cambiar.';
  end if;

  -- raw_data nunca decide por sí mismo: siempre refleja la columna.
  new.raw_data := case
    when new.stock_effect = 'none'
      then coalesce(new.raw_data, '{}'::jsonb) || jsonb_build_object('beyonix_stock_effect', 'none')
    else coalesce(new.raw_data, '{}'::jsonb) - 'beyonix_stock_effect'
  end;
  return new;
end;
$$;

-- "aa_" para correr antes que validate_ml_sale_variant y el resto de los
-- BEFORE triggers (se ejecutan en orden alfabético).
drop trigger if exists aa_mercadolibre_sale_stock_effect on public.mercadolibre_sales;
create trigger aa_mercadolibre_sale_stock_effect
  before insert or update on public.mercadolibre_sales
  for each row execute function public.mercadolibre_sale_sync_stock_effect();

create or replace function public.inventory_ml_stock_units(
  p_quantity integer,
  p_raw_data jsonb
)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  v_quantity integer := greatest(coalesce(p_quantity, 0), 0);
  v_status text := lower(coalesce(p_raw_data -> 'parsed' ->> 'status', ''));
begin
  -- Venta histórica: el stock actual ya la refleja.
  if coalesce(p_raw_data ->> 'beyonix_stock_effect', '') = 'none' then
    return 0;
  end if;

  if v_status like '%cancel%' or v_status like '%anulad%' then
    return 0;
  end if;

  return v_quantity;
end;
$$;

comment on function public.inventory_ml_stock_units(integer, jsonb) is
  'Unidades de una venta ML que salen del stock: 0 si es histórica (stock_effect = none) o cancelada; las devoluciones requieren reingreso aprobado.';

-- 3. Sin revisión física de devolución en ventas históricas --------------------

create or replace function public.reject_historical_mercadolibre_return_movement()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.mercadolibre_sale_id is not null and exists (
    select 1
    from public.mercadolibre_sales sales
    where sales.id = new.mercadolibre_sale_id
      and sales.stock_effect = 'none'
  ) then
    raise exception 'ML_HISTORICAL_SALE_RETURN: una venta histórica no registra devoluciones físicas porque el stock actual ya las refleja.';
  end if;
  return new;
end;
$$;

drop trigger if exists aa_reject_historical_mercadolibre_return on public.inventory_return_movements;
create trigger aa_reject_historical_mercadolibre_return
  before insert or update of mercadolibre_sale_id on public.inventory_return_movements
  for each row execute function public.reject_historical_mercadolibre_return_movement();

-- 4. Importación por lote con modo -----------------------------------------------
-- Idéntica a 20261015100000 salvo: stock_effect según el modo del lote al
-- crear, nunca cambia al actualizar, y la guarda de stock negativo sólo mira
-- productos de ventas que consumen stock.

create or replace function public.import_mercadolibre_sales_batch(
  p_batch_id uuid,
  p_rows jsonb,
  p_imported_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.mercadolibre_import_batches%rowtype;
  v_stock_effect text;
  v_row jsonb;
  v_raw_data jsonb;
  v_final_raw_data jsonb;
  v_source_key text;
  v_fingerprint text;
  v_seen jsonb := '{}'::jsonb;
  v_existing public.mercadolibre_sales%rowtype;
  v_product_id bigint;
  v_variant_id bigint;
  v_unit_cost numeric(12, 2);
  v_sale_date timestamptz;
  v_operation_id text;
  v_order_id text;
  v_product_name text;
  v_sku text;
  v_quantity integer;
  v_gross_amount numeric(12, 2);
  v_fee_amount numeric(12, 2);
  v_shipping_amount numeric(12, 2);
  v_net_amount numeric(12, 2);
  v_row_label text;
  v_received integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_duplicate_rows integer := 0;
  v_touched_product_ids bigint[] := '{}'::bigint[];
begin
  if p_rows is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 then
    raise exception 'ML_IMPORT_EMPTY: no hay ventas válidas para importar.';
  end if;

  if jsonb_array_length(p_rows) > 500 then
    raise exception 'ML_IMPORT_TOO_LARGE: cada bloque puede contener como máximo 500 ventas.';
  end if;

  perform pg_advisory_xact_lock(hashtext('beyonix_mercadolibre_import'));

  select *
  into v_batch
  from public.mercadolibre_import_batches batches
  where batches.id = p_batch_id
  for update;

  if not found then
    raise exception 'ML_IMPORT_BATCH_NOT_FOUND: el lote de importación no existe.';
  end if;

  if v_batch.status <> 'processing' then
    raise exception 'ML_IMPORT_BATCH_CLOSED: el lote de importación ya fue cerrado.';
  end if;

  v_stock_effect := case when v_batch.import_mode = 'historical' then 'none' else 'consume' end;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_received := v_received + 1;
    -- Las marcas internas nunca vienen del archivo.
    v_raw_data := coalesce(v_row -> 'raw_data', '{}'::jsonb) - 'beyonix_stock_effect';
    v_row_label := coalesce(v_raw_data #>> '{source,row_number}', v_received::text);

    if jsonb_typeof(v_raw_data) <> 'object'
       or jsonb_typeof(v_raw_data -> 'parsed') is distinct from 'object' then
      raise exception 'ML_IMPORT_INVALID_ROW: la fila % no tiene los datos originales del reporte.', v_row_label;
    end if;

    v_operation_id := nullif(btrim(v_row ->> 'operation_id'), '');
    if v_operation_id is null or v_operation_id !~ '^[0-9]+$' then
      raise exception 'ML_IMPORT_INVALID_ROW: la fila % no tiene un número de venta válido.', v_row_label;
    end if;

    begin
      v_sale_date := (v_row ->> 'sale_date')::timestamptz;
      v_quantity := (v_row ->> 'quantity')::integer;
      v_unit_cost := greatest(coalesce((v_row ->> 'unit_cost')::numeric, 0), 0);
      v_gross_amount := (v_row ->> 'gross_amount')::numeric;
      v_fee_amount := nullif(v_row ->> 'fee_amount', '')::numeric;
      v_shipping_amount := nullif(v_row ->> 'shipping_amount', '')::numeric;
      v_net_amount := nullif(v_row ->> 'net_amount', '')::numeric;
      v_product_id := nullif(v_row ->> 'product_id', '')::bigint;
      v_variant_id := nullif(v_raw_data #>> '{beyonix_cost_mapping,variant_id}', '')::bigint;
    exception when others then
      raise exception 'ML_IMPORT_INVALID_ROW: la fila % tiene fechas, cantidades o importes inválidos.', v_row_label;
    end;

    if v_sale_date is null then
      raise exception 'ML_IMPORT_INVALID_ROW: la fila % no tiene fecha de venta.', v_row_label;
    end if;
    if v_quantity is null or v_quantity < 1 then
      raise exception 'ML_IMPORT_INVALID_ROW: la fila % tiene unidades inválidas.', v_row_label;
    end if;
    if v_gross_amount is null then
      raise exception 'ML_IMPORT_INVALID_ROW: la fila % no tiene ingresos por productos.', v_row_label;
    end if;

    v_order_id := coalesce(nullif(btrim(v_row ->> 'order_id'), ''), v_operation_id);
    v_product_name := coalesce(nullif(btrim(v_row ->> 'product_name'), ''), 'Venta Mercado Libre');
    v_sku := nullif(btrim(v_row ->> 'sku'), '');

    v_source_key := public.mercadolibre_sale_source_key(
      v_operation_id, v_order_id, v_product_name, v_sku, v_sale_date, v_raw_data
    );
    v_fingerprint := md5(
      ((v_row - 'source_file_name') || jsonb_build_object('raw_data', v_raw_data - 'source'))::text
    );

    if v_seen ? v_source_key then
      if v_seen ->> v_source_key is distinct from v_fingerprint then
        raise exception 'ML_IMPORT_CONFLICT: la venta % aparece dos veces con datos distintos.', v_operation_id;
      end if;
      v_duplicate_rows := v_duplicate_rows + 1;
      continue;
    end if;
    v_seen := v_seen || jsonb_build_object(v_source_key, v_fingerprint);

    if v_product_id is not null then
      if not exists (select 1 from public.productos products where products.id = v_product_id) then
        raise exception 'ML_IMPORT_INVALID_ROW: la fila % apunta a un producto inexistente.', v_row_label;
      end if;
      if v_variant_id is not null and not exists (
        select 1
        from public.producto_variantes variants
        where variants.id = v_variant_id
          and variants.producto_id = v_product_id
      ) then
        raise exception 'ML_IMPORT_INVALID_ROW: la variante vinculada en la fila % no pertenece al producto.', v_row_label;
      end if;
    elsif v_variant_id is not null then
      raise exception 'ML_IMPORT_INVALID_ROW: la fila % tiene una variante sin producto vinculado.', v_row_label;
    end if;

    select *
    into v_existing
    from public.mercadolibre_sales sales
    where sales.source_key = v_source_key
    for update;

    if not found then
      if v_product_id is not null
         and v_stock_effect = 'consume'
         and array_position(v_touched_product_ids, v_product_id) is null then
        v_touched_product_ids := array_append(v_touched_product_ids, v_product_id);
      end if;

      insert into public.mercadolibre_sales (
        source_key, sale_date, operation_id, order_id, product_id, product_name,
        sku, quantity, unit_cost, gross_amount, fee_amount, shipping_amount,
        net_amount, source_file_name, imported_by, raw_data,
        import_batch_id, last_import_batch_id, stock_effect
      ) values (
        v_source_key, v_sale_date, v_operation_id, v_order_id, v_product_id, v_product_name,
        v_sku, v_quantity, v_unit_cost, v_gross_amount, v_fee_amount, v_shipping_amount,
        v_net_amount, v_batch.source_file_name, p_imported_by, v_raw_data,
        p_batch_id, p_batch_id, v_stock_effect
      );
      v_inserted := v_inserted + 1;
      continue;
    end if;

    -- Una venta existente conserva su efecto sobre el stock: reimportarla en
    -- otro modo nunca la convierte en histórica ni en actual.
    if v_existing.stock_effect = 'consume' then
      if v_existing.product_id is not null
         and array_position(v_touched_product_ids, v_existing.product_id) is null then
        v_touched_product_ids := array_append(v_touched_product_ids, v_existing.product_id);
      end if;
      if v_product_id is not null
         and array_position(v_touched_product_ids, v_product_id) is null then
        v_touched_product_ids := array_append(v_touched_product_ids, v_product_id);
      end if;
    end if;

    if exists (
      select 1
      from public.inventory_return_movements movements
      where movements.mercadolibre_sale_id = v_existing.id
        and movements.received_quantity > v_quantity
    ) then
      raise exception
        'ML_IMPORT_RETURN_CONFLICT: la venta % no puede reducirse por debajo de las unidades ya recibidas en devolución.',
        v_operation_id;
    end if;

    if v_existing.raw_data ? 'beyonix_cost_mapping' then
      v_final_raw_data := v_raw_data || jsonb_build_object(
        'beyonix_cost_mapping', v_existing.raw_data -> 'beyonix_cost_mapping'
      );
      v_product_id := v_existing.product_id;
      v_unit_cost := v_existing.unit_cost;
    else
      v_final_raw_data := v_raw_data;
      v_product_id := coalesce(v_product_id, v_existing.product_id);
      if v_product_id = v_existing.product_id and v_unit_cost = 0 then
        v_unit_cost := v_existing.unit_cost;
      end if;
    end if;

    -- Un reporte viejo cargado después de uno más completo no retrocede una
    -- cancelación, devolución o entrega ya observada.
    if public.mercadolibre_sale_evidence_score(v_final_raw_data)
       < public.mercadolibre_sale_evidence_score(v_existing.raw_data) then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    if row(
      v_existing.sale_date, v_existing.operation_id, v_existing.order_id,
      v_existing.product_id, v_existing.product_name, v_existing.sku,
      v_existing.quantity, v_existing.unit_cost, v_existing.gross_amount,
      v_existing.fee_amount, v_existing.shipping_amount, v_existing.net_amount,
      v_existing.raw_data - 'source' - 'beyonix_stock_effect'
    ) is not distinct from row(
      v_sale_date, v_operation_id, v_order_id,
      v_product_id, v_product_name, v_sku,
      v_quantity, v_unit_cost, v_gross_amount,
      v_fee_amount, v_shipping_amount, v_net_amount,
      v_final_raw_data - 'source'
    ) then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    update public.mercadolibre_sales
    set
      sale_date = v_sale_date,
      operation_id = v_operation_id,
      order_id = v_order_id,
      product_id = v_product_id,
      product_name = v_product_name,
      sku = v_sku,
      quantity = v_quantity,
      unit_cost = v_unit_cost,
      gross_amount = v_gross_amount,
      fee_amount = v_fee_amount,
      shipping_amount = v_shipping_amount,
      net_amount = v_net_amount,
      source_file_name = v_batch.source_file_name,
      imported_by = p_imported_by,
      imported_at = now(),
      raw_data = v_final_raw_data,
      last_import_batch_id = p_batch_id
    where id = v_existing.id;

    v_updated := v_updated + 1;
  end loop;

  if exists (
    select 1 from public.productos products
    where products.id = any(v_touched_product_ids) and products.stock < 0
  ) or exists (
    select 1 from public.producto_variantes variants
    where variants.producto_id = any(v_touched_product_ids) and variants.stock < 0
  ) then
    raise exception 'STOCK_INSUFICIENTE: la importación dejaría stock negativo.';
  end if;

  update public.mercadolibre_import_batches
  set
    inserted = inserted + v_inserted,
    updated = updated + v_updated,
    unchanged = unchanged + v_unchanged,
    rows_duplicate_in_file = rows_duplicate_in_file + v_duplicate_rows
  where id = p_batch_id;

  return jsonb_build_object(
    'received', v_received,
    'inserted', v_inserted,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'duplicate_rows', v_duplicate_rows
  );
end;
$$;

revoke all on function public.import_mercadolibre_sales_batch(uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.import_mercadolibre_sales_batch(uuid, jsonb, uuid)
  to service_role;

comment on function public.import_mercadolibre_sales_batch(uuid, jsonb, uuid) is
  'Importa un bloque de ventas ML dentro de un lote: idempotente, con trazabilidad por lote; en lotes históricos las ventas nuevas no mueven stock.';

-- 5. Vínculos explícitos con el catálogo -------------------------------------------

-- Claves canónicas, idénticas a lib/mercadolibre/product-matching.ts:
--   publicación: mayúsculas, sólo A-Z y 0-9 ("mla-123" → "MLA123");
--   variante: sin tildes, minúsculas, espacios colapsados y sin espacios
--   alrededor de ":" ("Color :  Rosa" → "color:rosa").
create or replace function public.mercadolibre_listing_key(p_listing text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(upper(coalesce(p_listing, '')), '[^A-Z0-9]', '', 'g');
$$;

create or replace function public.mercadolibre_variant_key(p_variant text)
returns text
language sql
immutable
set search_path = public
as $$
  select btrim(regexp_replace(regexp_replace(
    lower(translate(
      regexp_replace(
        regexp_replace(coalesce(p_variant, ''), '[​-‍⁠﻿]', '', 'g'),
        '[\s  ]+', ' ', 'g'
      ),
      'ÁÀÄÂÃÅáàäâãåÉÈËÊéèëêÍÌÏÎíìïîÓÒÖÔÕóòöôõÚÙÜÛúùüûÑñÇçÝý',
      'aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunnccyy'
    )),
    '\s*:\s*', ':', 'g'), '\s+', ' ', 'g'));
$$;

create table if not exists public.product_channel_mappings (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  mapping_type text not null,
  match_key text not null,
  external_sku text,
  listing_id text,
  variant_label text,
  -- Borrar un producto/variante nunca borra el historial: el destino queda
  -- en null, el vínculo se desactiva y original_* conserva a qué apuntaba.
  product_id bigint references public.productos(id) on delete set null,
  variant_id bigint references public.producto_variantes(id) on delete set null,
  original_product_id bigint not null,
  original_variant_id bigint,
  active boolean not null default true,
  origin text not null default 'manual_admin',
  valid_from date,
  valid_to date,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  deactivated_by uuid,
  deactivation_reason text,
  constraint product_channel_mappings_channel_check check (channel in ('mercadolibre')),
  constraint product_channel_mappings_type_check check (mapping_type in ('sku_alias', 'listing_variant')),
  constraint product_channel_mappings_origin_check check (origin in ('manual_import_preview', 'manual_admin')),
  constraint product_channel_mappings_shape_check check (
    (
      mapping_type = 'sku_alias'
      and external_sku is not null
      and btrim(external_sku) <> ''
      and match_key = upper(btrim(external_sku))
      and listing_id is null
      and variant_label is null
    )
    or (
      mapping_type = 'listing_variant'
      and external_sku is null
      and listing_id is not null
      and listing_id <> ''
      and listing_id = public.mercadolibre_listing_key(listing_id)
      and variant_label is not null
      and public.mercadolibre_variant_key(variant_label) <> ''
      and match_key = listing_id || '|' || public.mercadolibre_variant_key(variant_label)
    )
  ),
  constraint product_channel_mappings_validity_check check (
    valid_from is null or valid_to is null or valid_to >= valid_from
  ),
  constraint product_channel_mappings_active_check check (
    (active and deactivated_at is null and deactivation_reason is null)
    or (not active and deactivated_at is not null and deactivation_reason is not null)
  ),
  constraint product_channel_mappings_reason_check check (
    deactivation_reason is null or deactivation_reason in ('manual', 'catalog_target_deleted')
  ),
  -- Un vínculo activo siempre tiene destino; el destino sólo puede quedar en
  -- null (catálogo borrado), nunca cambiar a otro producto/variante.
  constraint product_channel_mappings_target_check check (
    (not active or product_id is not null)
    and (product_id is null or product_id = original_product_id)
    and (variant_id is null or variant_id = original_variant_id)
  )
);

-- Un mismo SKU o publicación + variante puede tener varios vínculos activos
-- sólo en períodos que no se superponen (lo garantiza el trigger).
create index if not exists product_channel_mappings_active_key_idx
  on public.product_channel_mappings(channel, mapping_type, match_key)
  where active;
create index if not exists product_channel_mappings_product_idx
  on public.product_channel_mappings(product_id);
create index if not exists product_channel_mappings_variant_idx
  on public.product_channel_mappings(variant_id);

comment on table public.product_channel_mappings is
  'Vínculos explícitos de un SKU histórico/alias o de una publicación + variante de un canal con un producto/variante actual. Sin coincidencias aproximadas.';
comment on column public.product_channel_mappings.match_key is
  'Clave normalizada: SKU en mayúsculas (sku_alias) o PUBLICACION|variante normalizada (listing_variant).';

create or replace function public.validate_product_channel_mapping()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if row(
      new.channel, new.mapping_type, new.match_key, new.external_sku, new.listing_id,
      new.variant_label, new.origin, new.created_at, new.created_by,
      new.valid_from, new.valid_to, new.original_product_id, new.original_variant_id
    ) is distinct from row(
      old.channel, old.mapping_type, old.match_key, old.external_sku, old.listing_id,
      old.variant_label, old.origin, old.created_at, old.created_by,
      old.valid_from, old.valid_to, old.original_product_id, old.original_variant_id
    ) then
      raise exception 'PRODUCT_MAPPING_IMMUTABLE: un vínculo no se edita; desactivalo y creá uno nuevo.';
    end if;
    -- El destino sólo puede desaparecer (ON DELETE SET NULL del catálogo).
    if (new.product_id is distinct from old.product_id and new.product_id is not null)
       or (new.variant_id is distinct from old.variant_id and new.variant_id is not null) then
      raise exception 'PRODUCT_MAPPING_IMMUTABLE: el destino de un vínculo no se cambia; desactivalo y creá uno nuevo.';
    end if;
    if new.active and not old.active then
      raise exception 'PRODUCT_MAPPING_IMMUTABLE: un vínculo desactivado no se reactiva; creá uno nuevo.';
    end if;

    -- Producto o variante borrados: el vínculo queda en el historial, inactivo.
    if new.product_id is null or (old.variant_id is not null and new.variant_id is null) then
      if new.active then
        new.active := false;
        new.deactivated_at := now();
        new.deactivated_by := null;
        new.deactivation_reason := 'catalog_target_deleted';
      end if;
    elsif not new.active and old.active then
      new.deactivation_reason := coalesce(new.deactivation_reason, 'manual');
    end if;
    new.updated_at := now();
    return new;
  end if;

  -- El destino original se fija acá y nunca cambia: sobrevive al borrado.
  new.original_product_id := new.product_id;
  new.original_variant_id := new.variant_id;
  if new.product_id is null then
    raise exception 'PRODUCT_MAPPING_TARGET_REQUIRED: el vínculo necesita un producto.';
  end if;
  if new.valid_from is not null and new.valid_to is not null and new.valid_to < new.valid_from then
    raise exception 'PRODUCT_MAPPING_INVALID_PERIOD: la vigencia termina antes de empezar.';
  end if;

  -- Un SKU o publicación + variante tiene a lo sumo un vínculo activo por
  -- fecha: los períodos de vigencia no se superponen. El lock serializa dos
  -- altas concurrentes de la misma clave.
  if new.active then
    perform pg_advisory_xact_lock(
      hashtext('product_channel_mapping:' || new.channel || ':' || new.mapping_type || ':' || new.match_key)
    );
    if exists (
      select 1
      from public.product_channel_mappings mappings
      where mappings.active
        and mappings.channel = new.channel
        and mappings.mapping_type = new.mapping_type
        and mappings.match_key = new.match_key
        and daterange(coalesce(mappings.valid_from, '-infinity'::date), coalesce(mappings.valid_to, 'infinity'::date), '[]')
          && daterange(coalesce(new.valid_from, '-infinity'::date), coalesce(new.valid_to, 'infinity'::date), '[]')
    ) then
      raise exception 'PRODUCT_MAPPING_OVERLAP: ya existe un vínculo activo para esa clave en ese período.';
    end if;
  end if;

  if new.variant_id is not null then
    if not exists (
      select 1 from public.producto_variantes variants
      where variants.id = new.variant_id and variants.producto_id = new.product_id
    ) then
      raise exception 'PRODUCT_MAPPING_VARIANT_MISMATCH: la variante no pertenece al producto.';
    end if;
  elsif exists (
    select 1 from public.producto_variantes variants
    where variants.producto_id = new.product_id
  ) then
    raise exception 'PRODUCT_MAPPING_VARIANT_REQUIRED: el producto tiene variantes; elegí la variante exacta.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_product_channel_mapping on public.product_channel_mappings;
create trigger validate_product_channel_mapping
  before insert or update on public.product_channel_mappings
  for each row execute function public.validate_product_channel_mapping();

drop trigger if exists product_channel_mappings_audit_log_trigger on public.product_channel_mappings;
create trigger product_channel_mappings_audit_log_trigger
  after insert or update or delete on public.product_channel_mappings
  for each row execute function public.audit_log_change();

alter table public.product_channel_mappings enable row level security;
revoke all on public.product_channel_mappings from public, anon, authenticated;
grant all on public.product_channel_mappings to service_role;

notify pgrst, 'reload schema';
