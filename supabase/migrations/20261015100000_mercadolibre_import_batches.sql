-- Importación de ventas de Mercado Libre: historial por archivo, trazabilidad
-- de qué lote creó cada venta, previsualización contra la base y reversión
-- segura de un lote importado por error.

-- 1. Historial de importaciones -------------------------------------------

create table if not exists public.mercadolibre_import_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  imported_by uuid,
  source_file_name text,
  file_sha256 text,
  file_kind text,
  sheet_name text,
  columns jsonb not null default '[]'::jsonb,
  rows_read integer not null default 0,
  rows_valid integer not null default 0,
  rows_invalid integer not null default 0,
  rows_duplicate_in_file integer not null default 0,
  inserted integer not null default 0,
  updated integer not null default 0,
  unchanged integer not null default 0,
  invalid_rows jsonb not null default '[]'::jsonb,
  status text not null default 'processing',
  error_message text,
  reverted_at timestamptz,
  reverted_by uuid,
  reverted_count integer not null default 0,
  constraint mercadolibre_import_batches_status_check check (
    status in ('processing', 'completed', 'failed', 'reverted', 'partially_reverted')
  ),
  constraint mercadolibre_import_batches_counts_check check (
    rows_read >= 0 and rows_valid >= 0 and rows_invalid >= 0
    and rows_duplicate_in_file >= 0 and inserted >= 0 and updated >= 0
    and unchanged >= 0 and reverted_count >= 0
  ),
  constraint mercadolibre_import_batches_sha_check check (
    file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'
  )
);

create index if not exists mercadolibre_import_batches_created_at_idx
  on public.mercadolibre_import_batches(created_at desc);
create index if not exists mercadolibre_import_batches_sha_idx
  on public.mercadolibre_import_batches(file_sha256);

alter table public.mercadolibre_import_batches enable row level security;
revoke all on public.mercadolibre_import_batches from public, anon, authenticated;
grant all on public.mercadolibre_import_batches to service_role;

comment on table public.mercadolibre_import_batches is
  'Una fila por archivo de ventas ML importado: quién, cuándo, qué archivo y cuántas ventas creó/actualizó/ignoró.';

alter table public.mercadolibre_sales
  add column if not exists import_batch_id uuid
    references public.mercadolibre_import_batches(id) on delete set null,
  add column if not exists last_import_batch_id uuid
    references public.mercadolibre_import_batches(id) on delete set null;

create index if not exists mercadolibre_sales_import_batch_idx
  on public.mercadolibre_sales(import_batch_id);
create index if not exists mercadolibre_sales_last_import_batch_idx
  on public.mercadolibre_sales(last_import_batch_id);

comment on column public.mercadolibre_sales.import_batch_id is
  'Lote de importación que creó la venta (null en ventas manuales o anteriores al historial).';
comment on column public.mercadolibre_sales.last_import_batch_id is
  'Último lote que creó o modificó la venta. Una venta sólo es reversible si coincide con import_batch_id.';

-- 2. Identidad v2 ------------------------------------------------------------
-- Igual que v1 pero insensible a espacios repetidos y a separadores en el
-- número de publicación: dos reportes del mismo período no deben crear dos
-- ventas porque ML cambió un espacio en el nombre de la variante.

create or replace function public.mercadolibre_sale_source_key(
  p_operation_id text,
  p_order_id text,
  p_product_name text,
  p_sku text,
  p_sale_date timestamptz,
  p_raw_data jsonb
)
returns text
language sql
immutable
set search_path = public
as $$
  with normalized as (
    select
      lower(regexp_replace(btrim(coalesce(p_operation_id, '')), '\s+', ' ', 'g')) as operation_id,
      lower(regexp_replace(btrim(coalesce(p_order_id, '')), '\s+', ' ', 'g')) as order_id,
      lower(regexp_replace(btrim(coalesce(p_product_name, '')), '\s+', ' ', 'g')) as product_name,
      lower(regexp_replace(btrim(coalesce(p_sku, '')), '\s+', ' ', 'g')) as sku,
      regexp_replace(lower(coalesce(p_raw_data #>> '{parsed,listing_id}', '')), '[^[:alnum:]]', '', 'g') as listing_id,
      lower(regexp_replace(btrim(coalesce(p_raw_data #>> '{parsed,variant}', '')), '\s+', ' ', 'g')) as variant_name
  )
  select
    'ml:v2:' || md5(
      case
        when operation_id <> '' then concat_ws(
          chr(31),
          'operation',
          operation_id,
          case when listing_id <> '' then 'listing' when sku <> '' then 'sku' else 'product' end,
          case when listing_id <> '' then listing_id when sku <> '' then sku else product_name end,
          'variant',
          variant_name
        )
        else concat_ws(
          chr(31),
          'order',
          order_id,
          'sale_date',
          coalesce(extract(epoch from p_sale_date)::text, ''),
          case when listing_id <> '' then 'listing' when sku <> '' then 'sku' else 'product' end,
          case when listing_id <> '' then listing_id when sku <> '' then sku else product_name end,
          'variant',
          variant_name
        )
      end
    )
  from normalized;
$$;

-- Recalcula las identidades existentes. Si dos ventas históricas colapsan en
-- la misma identidad v2, la más antigua la conserva y la otra queda marcada
-- como legado: nunca se borra una venta para endurecer la unicidad.
with recomputed as (
  select
    sales.id,
    public.mercadolibre_sale_source_key(
      sales.operation_id,
      sales.order_id,
      sales.product_name,
      sales.sku,
      sales.sale_date,
      sales.raw_data
    ) as new_key,
    sales.imported_at
  from public.mercadolibre_sales sales
),
ranked as (
  select
    recomputed.*,
    row_number() over (partition by new_key order by imported_at, id) as position
  from recomputed
)
update public.mercadolibre_sales sales
set source_key = case
  when ranked.position = 1 then ranked.new_key
  else ranked.new_key || ':legacy:' || sales.id::text
end
from ranked
where ranked.id = sales.id
  and sales.source_key is distinct from case
    when ranked.position = 1 then ranked.new_key
    else ranked.new_key || ':legacy:' || sales.id::text
  end;

-- 3. Importación por lote -------------------------------------------------

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

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_received := v_received + 1;
    v_raw_data := coalesce(v_row -> 'raw_data', '{}'::jsonb);
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

    if v_product_id is not null and array_position(v_touched_product_ids, v_product_id) is null then
      v_touched_product_ids := array_append(v_touched_product_ids, v_product_id);
    end if;

    select *
    into v_existing
    from public.mercadolibre_sales sales
    where sales.source_key = v_source_key
    for update;

    if not found then
      insert into public.mercadolibre_sales (
        source_key, sale_date, operation_id, order_id, product_id, product_name,
        sku, quantity, unit_cost, gross_amount, fee_amount, shipping_amount,
        net_amount, source_file_name, imported_by, raw_data,
        import_batch_id, last_import_batch_id
      ) values (
        v_source_key, v_sale_date, v_operation_id, v_order_id, v_product_id, v_product_name,
        v_sku, v_quantity, v_unit_cost, v_gross_amount, v_fee_amount, v_shipping_amount,
        v_net_amount, v_batch.source_file_name, p_imported_by, v_raw_data,
        p_batch_id, p_batch_id
      );
      v_inserted := v_inserted + 1;
      continue;
    end if;

    if v_existing.product_id is not null
       and array_position(v_touched_product_ids, v_existing.product_id) is null then
      v_touched_product_ids := array_append(v_touched_product_ids, v_existing.product_id);
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
      v_existing.raw_data - 'source'
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
  'Importa un bloque de ventas ML dentro de un lote: idempotente, sin reemplazar UUID, con trazabilidad por lote.';

-- import_mercadolibre_sales_idempotent (sin lote) se conserva sólo para que
-- la versión desplegada siga funcionando si esta migración se aplica antes
-- que el código nuevo; usa la misma identidad v2, así que no duplica. El
-- código nuevo ya no la llama: eliminarla en una migración posterior.

-- 4. Previsualización contra la base (sólo lectura) ------------------------

create or replace function public.preview_mercadolibre_import(p_rows jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with incoming as (
    select
      rows.ordinality - 1 as position,
      rows.value as row_data,
      public.mercadolibre_sale_source_key(
        nullif(btrim(rows.value ->> 'operation_id'), ''),
        coalesce(nullif(btrim(rows.value ->> 'order_id'), ''), nullif(btrim(rows.value ->> 'operation_id'), '')),
        coalesce(nullif(btrim(rows.value ->> 'product_name'), ''), 'Venta Mercado Libre'),
        nullif(btrim(rows.value ->> 'sku'), ''),
        nullif(rows.value ->> 'sale_date', '')::timestamptz,
        coalesce(rows.value -> 'raw_data', '{}'::jsonb)
      ) as source_key
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as rows(value, ordinality)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'index', incoming.position,
        'status', case
          when sales.id is null then 'new'
          when public.mercadolibre_sale_evidence_score(coalesce(incoming.row_data -> 'raw_data', '{}'::jsonb))
             < public.mercadolibre_sale_evidence_score(sales.raw_data) then 'stale'
          when sales.raw_data -> 'parsed' = incoming.row_data #> '{raw_data,parsed}'
             and sales.sale_date = nullif(incoming.row_data ->> 'sale_date', '')::timestamptz
             and sales.quantity = (incoming.row_data ->> 'quantity')::integer
             and sales.gross_amount = (incoming.row_data ->> 'gross_amount')::numeric
             and sales.net_amount is not distinct from nullif(incoming.row_data ->> 'net_amount', '')::numeric
            then 'unchanged'
          else 'changed'
        end
      )
      order by incoming.position
    ),
    '[]'::jsonb
  )
  from incoming
  left join public.mercadolibre_sales sales on sales.source_key = incoming.source_key;
$$;

revoke all on function public.preview_mercadolibre_import(jsonb) from public, anon, authenticated;
grant execute on function public.preview_mercadolibre_import(jsonb) to service_role;

comment on function public.preview_mercadolibre_import(jsonb) is
  'Clasifica cada fila de un reporte ML como nueva, sin cambios, con cambios o más vieja que lo ya cargado. No escribe.';

-- 5. Reversión de un lote -------------------------------------------------
-- Sólo elimina ventas que el lote creó y que nadie modificó después (otra
-- importación o una revisión física de devolución). Las ventas que el lote
-- sólo actualizó no se pueden volver atrás porque no se guarda la versión
-- anterior: se informan como no reversibles.

create or replace function public.revert_mercadolibre_import_batch(
  p_batch_id uuid,
  p_expected_count integer,
  p_reverted_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.mercadolibre_import_batches%rowtype;
  v_reversible integer;
  v_touched_later integer;
  v_with_returns integer;
  v_deleted integer;
  v_status text;
begin
  perform pg_advisory_xact_lock(hashtext('beyonix_mercadolibre_import'));

  select * into v_batch
  from public.mercadolibre_import_batches batches
  where batches.id = p_batch_id
  for update;

  if not found then
    raise exception 'ML_IMPORT_BATCH_NOT_FOUND: el lote de importación no existe.';
  end if;
  -- Un lote 'processing' sólo es reversible si quedó abandonado (el navegador
  -- se cerró a mitad de la carga); uno en curso podría seguir sumando ventas.
  if v_batch.status not in ('completed', 'failed')
     and not (v_batch.status = 'processing' and v_batch.created_at < now() - interval '15 minutes') then
    raise exception 'ML_IMPORT_BATCH_NOT_REVERSIBLE: este lote no se puede revertir (estado %).', v_batch.status;
  end if;

  select
    count(*) filter (
      where sales.last_import_batch_id = p_batch_id
        and not exists (
          select 1 from public.inventory_return_movements movements
          where movements.mercadolibre_sale_id = sales.id
        )
    )::integer,
    count(*) filter (where sales.last_import_batch_id is distinct from p_batch_id)::integer,
    count(*) filter (
      where sales.last_import_batch_id = p_batch_id
        and exists (
          select 1 from public.inventory_return_movements movements
          where movements.mercadolibre_sale_id = sales.id
        )
    )::integer
  into v_reversible, v_touched_later, v_with_returns
  from public.mercadolibre_sales sales
  where sales.import_batch_id = p_batch_id;

  if p_expected_count is distinct from v_reversible then
    raise exception
      'ML_IMPORT_REVERT_CHANGED: las ventas del lote cambiaron (se esperaban % y hay %). Recargá y confirmá de nuevo.',
      p_expected_count, v_reversible;
  end if;

  delete from public.mercadolibre_sales sales
  where sales.import_batch_id = p_batch_id
    and sales.last_import_batch_id = p_batch_id
    and not exists (
      select 1 from public.inventory_return_movements movements
      where movements.mercadolibre_sale_id = sales.id
    );
  get diagnostics v_deleted = row_count;

  v_status := case
    when v_touched_later = 0 and v_with_returns = 0 and v_batch.updated = 0 then 'reverted'
    else 'partially_reverted'
  end;

  update public.mercadolibre_import_batches
  set
    status = v_status,
    reverted_at = now(),
    reverted_by = p_reverted_by,
    reverted_count = v_deleted
  where id = p_batch_id;

  insert into public.audit_logs (table_name, action, record_id, actor_user_id, before_data, after_data)
  values (
    'mercadolibre_sales',
    'DELETE',
    'import-batch:' || p_batch_id::text,
    p_reverted_by,
    jsonb_build_object(
      'source_file_name', v_batch.source_file_name,
      'batch_created_at', v_batch.created_at,
      'deleted_count', v_deleted
    ),
    jsonb_build_object(
      'scope', 'import_batch_revert',
      'kept_modified_later', v_touched_later,
      'kept_with_return_review', v_with_returns,
      'updated_not_reversible', v_batch.updated
    )
  );

  return jsonb_build_object(
    'deleted', v_deleted,
    'kept_modified_later', v_touched_later,
    'kept_with_return_review', v_with_returns,
    'updated_not_reversible', v_batch.updated,
    'status', v_status
  );
end;
$$;

revoke all on function public.revert_mercadolibre_import_batch(uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.revert_mercadolibre_import_batch(uuid, integer, uuid)
  to service_role;

comment on function public.revert_mercadolibre_import_batch(uuid, integer, uuid) is
  'Elimina las ventas que un lote creó y nadie modificó después; deja constancia en audit_logs.';
