-- Importación ML: el tipo de importación y el impacto en stock se desacoplan.
--
-- historical = la venta ocurrió en el pasado (reconstrucción histórica).
-- stock_effect = si la venta afecta el inventario: consume | none.
-- Combinaciones válidas por lote: historical+consume, historical+none,
-- current+consume. current+none se rechaza (una venta actual siempre sale del
-- stock).
--
-- 1. mercadolibre_import_batches.stock_effect: elección explícita, inmutable.
--    Backfill: historical -> none, current -> consume (comportamiento previo).
--    Un INSERT sin stock_effect (código anterior a este cambio) recibe el
--    mismo valor derivado del modo, para no romper el despliegue en curso.
-- 2. La base garantiza que una venta consume tiene un vínculo válido con el
--    catálogo, para cualquier escritura; borrar el producto o la variante de
--    una venta consume se bloquea.
-- 3. import_mercadolibre_sales_batch: la venta nueva copia el stock_effect del
--    lote (sigue inmutable en la venta), una venta nueva consume sin producto
--    vinculado se rechaza y una venta consume legada sin vínculo nunca se
--    vincula sola: sólo por acción explícita del administrador.

-- 1. Impacto en stock del lote ------------------------------------------------

alter table public.mercadolibre_import_batches
  add column if not exists stock_effect text;

update public.mercadolibre_import_batches
set stock_effect = case when import_mode = 'historical' then 'none' else 'consume' end
where stock_effect is null;

alter table public.mercadolibre_import_batches
  alter column stock_effect set not null;

alter table public.mercadolibre_import_batches
  drop constraint if exists mercadolibre_import_batches_stock_effect_check;
alter table public.mercadolibre_import_batches
  add constraint mercadolibre_import_batches_stock_effect_check
  check (stock_effect in ('consume', 'none'));

alter table public.mercadolibre_import_batches
  drop constraint if exists mercadolibre_import_batches_mode_effect_check;
alter table public.mercadolibre_import_batches
  add constraint mercadolibre_import_batches_mode_effect_check
  check (import_mode = 'historical' or stock_effect = 'consume');

comment on column public.mercadolibre_import_batches.stock_effect is
  'consume: las ventas nuevas del lote descuentan stock. none: el stock ya las refleja. current exige consume. Inmutable.';
comment on column public.mercadolibre_import_batches.import_mode is
  'historical: ventas ocurridas en el pasado (reconstrucción). current: ventas actuales. No decide el stock: eso es stock_effect.';

create or replace function public.default_mercadolibre_import_batch_stock_effect()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.stock_effect := coalesce(
    new.stock_effect,
    case when new.import_mode = 'historical' then 'none' else 'consume' end
  );
  return new;
end;
$$;

drop trigger if exists default_mercadolibre_import_batch_stock_effect on public.mercadolibre_import_batches;
create trigger default_mercadolibre_import_batch_stock_effect
  before insert on public.mercadolibre_import_batches
  for each row execute function public.default_mercadolibre_import_batch_stock_effect();

create or replace function public.guard_mercadolibre_import_batch_mode()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.import_mode is distinct from old.import_mode then
    raise exception 'ML_IMPORT_MODE_IMMUTABLE: el modo de una importación no se puede cambiar.';
  end if;
  if new.stock_effect is distinct from old.stock_effect then
    raise exception 'ML_IMPORT_MODE_IMMUTABLE: el impacto en stock de una importación no se puede cambiar.';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_mercadolibre_import_batch_mode on public.mercadolibre_import_batches;
create trigger guard_mercadolibre_import_batch_mode
  before update of import_mode, stock_effect on public.mercadolibre_import_batches
  for each row execute function public.guard_mercadolibre_import_batch_mode();

-- 2. Una venta consume siempre tiene un vínculo válido ---------------------------
-- Vínculo válido: product_id existe (FK); si el producto tiene variantes, la
-- variante (raw_data.beyonix_cost_mapping.variant_id) existe y pertenece al
-- producto; sin variantes, no se admite una variante ajena. Vale para
-- cualquier escritura (RPC, SQL manual, service_role, bug de backend).
--
-- Legado: una venta consume que ya estaba sin producto antes de esta regla
-- puede seguir actualizándose SIN producto (queda pendiente de vínculo
-- manual), pero nunca pasar a un vínculo inválido. Igual que
-- validate_ml_sale_variant, una venta ya imputada al producto general antes
-- de que el producto tuviera variantes conserva esa imputación mientras no
-- cambie su vínculo.

create or replace function public.validate_mercadolibre_consume_link()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_variant_id bigint;
  v_old_variant_id bigint;
begin
  if new.stock_effect is distinct from 'consume' then
    return new;
  end if;

  if new.product_id is null then
    if tg_op = 'UPDATE' and old.product_id is null then
      return new;
    end if;
    raise exception
      'ML_CONSUME_SALE_LINK_REQUIRED: la venta % descuenta stock y necesita un producto vinculado; no se puede desvincular ni borrar su producto.',
      coalesce(new.operation_id, new.id::text);
  end if;

  if not exists (select 1 from public.productos products where products.id = new.product_id) then
    raise exception
      'ML_CONSUME_SALE_LINK_REQUIRED: el producto de la venta % no existe.',
      coalesce(new.operation_id, new.id::text);
  end if;

  v_variant_id := public.inventory_ml_variant_id(new.raw_data);

  if v_variant_id is not null then
    if not exists (
      select 1 from public.producto_variantes variants
      where variants.id = v_variant_id and variants.producto_id = new.product_id
    ) then
      raise exception
        'ML_CONSUME_SALE_LINK_REQUIRED: la variante de la venta % no existe o no pertenece al producto.',
        coalesce(new.operation_id, new.id::text);
    end if;
    return new;
  end if;

  if exists (
    select 1 from public.producto_variantes variants
    where variants.producto_id = new.product_id
  ) then
    if tg_op = 'UPDATE' then
      v_old_variant_id := public.inventory_ml_variant_id(old.raw_data);
      if old.product_id = new.product_id and v_old_variant_id is null then
        return new;
      end if;
    end if;
    raise exception
      'ML_CONSUME_SALE_LINK_REQUIRED: el producto de la venta % tiene variantes; elegí la variante exacta.',
      coalesce(new.operation_id, new.id::text);
  end if;

  return new;
end;
$$;

-- "ab_": después de aa_mercadolibre_sale_stock_effect (inmutabilidad y marca
-- en raw_data) y antes del resto de los BEFORE triggers. Cada escritura de la
-- RPC es una sola sentencia con la fila completa: no hay estados intermedios.
drop trigger if exists ab_validate_mercadolibre_consume_link on public.mercadolibre_sales;
create trigger ab_validate_mercadolibre_consume_link
  before insert or update on public.mercadolibre_sales
  for each row execute function public.validate_mercadolibre_consume_link();

-- Borrar un producto ya queda cubierto: su ON DELETE SET NULL actualiza la
-- venta y el trigger anterior lo rechaza. La variante vive en raw_data (sin
-- FK), así que su borrado se bloquea acá, incluso para ventas canceladas que
-- no dejan movimiento de inventario.
create index if not exists mercadolibre_sales_consume_variant_idx
  on public.mercadolibre_sales (public.inventory_ml_variant_id(raw_data))
  where stock_effect = 'consume';

create or replace function public.guard_variant_delete_mercadolibre_consume()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.mercadolibre_sales sales
    where sales.stock_effect = 'consume'
      and public.inventory_ml_variant_id(sales.raw_data) = old.id
  ) then
    raise exception
      'ML_CONSUME_SALE_LINK_REQUIRED: la variante % tiene ventas de Mercado Libre que descuentan stock; no se puede eliminar.',
      old.id;
  end if;
  return old;
end;
$$;

drop trigger if exists aa_guard_variant_delete_mercadolibre_consume on public.producto_variantes;
create trigger aa_guard_variant_delete_mercadolibre_consume
  before delete on public.producto_variantes
  for each row execute function public.guard_variant_delete_mercadolibre_consume();

-- 3. Importación por lote -------------------------------------------------------
-- Idéntica a 20261031150000 salvo: el stock_effect sale del lote (no del modo),
-- una venta nueva consume sin producto vinculado se rechaza y una venta
-- consume legada sin vínculo nunca se vincula sola al reimportar.
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

  v_stock_effect := v_batch.stock_effect;

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
      -- Una venta que descuenta stock tiene que saber de qué producto sale.
      if v_stock_effect = 'consume' and v_product_id is null then
        raise exception
          'ML_IMPORT_UNLINKED_CONSUME: la fila % descuenta stock y no tiene producto vinculado.',
          v_row_label;
      end if;

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
    elsif v_existing.stock_effect = 'consume' and v_existing.product_id is null then
      -- Legado consume sin vínculo: vincularla genera su salida de stock, así
      -- que nunca se vincula sola (ni por un SKU o vínculo nuevo). Sigue
      -- pendiente hasta la vinculación explícita del administrador.
      v_final_raw_data := v_raw_data - 'beyonix_cost_mapping';
      v_product_id := null;
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
  'Importa un bloque de ventas ML dentro de un lote: idempotente, con trazabilidad por lote; las ventas nuevas toman el stock_effect del lote y, si consumen, deben estar vinculadas.';

revoke all on function public.import_mercadolibre_sales_batch(uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.import_mercadolibre_sales_batch(uuid, jsonb, uuid)
  to service_role;

notify pgrst, 'reload schema';