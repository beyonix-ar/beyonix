-- Importación idempotente y no destructiva de reportes de ventas de Mercado Libre.
-- Una venta conserva siempre su UUID para no perder revisiones de devolución.

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
      lower(btrim(coalesce(p_operation_id, ''))) as operation_id,
      lower(btrim(coalesce(p_order_id, ''))) as order_id,
      lower(btrim(coalesce(p_product_name, ''))) as product_name,
      lower(btrim(coalesce(p_sku, ''))) as sku,
      lower(btrim(coalesce(p_raw_data #>> '{parsed,listing_id}', ''))) as listing_id,
      lower(btrim(coalesce(p_raw_data #>> '{parsed,variant}', ''))) as variant_name
  )
  select
    'ml:v1:' || md5(
      case
        when operation_id <> '' then concat_ws(
          chr(31),
          'operation',
          operation_id,
          case
            when listing_id <> '' then 'listing'
            when sku <> '' then 'sku'
            else 'product'
          end,
          case
            when listing_id <> '' then listing_id
            when sku <> '' then sku
            else product_name
          end,
          'variant',
          variant_name
        )
        else concat_ws(
          chr(31),
          'order',
          order_id,
          'sale_date',
          coalesce(extract(epoch from p_sale_date)::text, ''),
          case
            when listing_id <> '' then 'listing'
            when sku <> '' then 'sku'
            else 'product'
          end,
          case
            when listing_id <> '' then listing_id
            when sku <> '' then sku
            else product_name
          end,
          'variant',
          variant_name
        )
      end
    )
  from normalized;
$$;

alter table public.mercadolibre_sales
  add column if not exists source_key text;

update public.mercadolibre_sales sales
set source_key = public.mercadolibre_sale_source_key(
  sales.operation_id,
  sales.order_id,
  sales.product_name,
  sales.sku,
  sales.sale_date,
  sales.raw_data
)
where sales.source_key is null
   or btrim(sales.source_key) = '';

do $$
declare
  v_duplicate_keys integer;
begin
  select count(*)
  into v_duplicate_keys
  from (
    select sales.source_key
    from public.mercadolibre_sales sales
    group by sales.source_key
    having count(*) > 1
  ) duplicates;

  if v_duplicate_keys > 0 then
    raise exception
      'Hay % identidades duplicadas en mercadolibre_sales. La migración se detuvo sin borrar datos.',
      v_duplicate_keys;
  end if;
end;
$$;

alter table public.mercadolibre_sales
  alter column source_key set not null;

create unique index if not exists mercadolibre_sales_source_key_unique
  on public.mercadolibre_sales(source_key);

create index if not exists mercadolibre_sales_order_id_idx
  on public.mercadolibre_sales(order_id);

comment on column public.mercadolibre_sales.source_key is
  'Identidad estable de la venta/publicación/variante de ML. Impide duplicados entre archivos y reimportaciones.';

create or replace function public.mercadolibre_sale_lifecycle_rank(
  p_raw_data jsonb
)
returns integer
language sql
immutable
set search_path = public
as $$
  with fields as (
    select
      lower(coalesce(p_raw_data #>> '{parsed,status}', '')) as status,
      coalesce(
        nullif(p_raw_data #>> '{parsed,return_units}', '')::numeric,
        0
      ) as return_units,
      coalesce(
        nullif(p_raw_data #>> '{parsed,cancellations_refunds}', '')::numeric,
        0
      ) as cancellations_refunds
  )
  select case
    when status like '%cancel%'
      or status like '%anulad%'
      then 500
    when return_units > 0
      or cancellations_refunds <> 0
      or status like '%devol%'
      or status like '%reembols%'
      then 400
    when status like '%entreg%'
      or status like '%finaliz%'
      or status like '%complet%'
      then 300
    when status like '%tránsito%'
      or status like '%transito%'
      or status like '%enviad%'
      or status like '%despach%'
      then 200
    when status like '%pag%'
      or status like '%confirm%'
      or status like '%aprobad%'
      then 100
    else 0
  end
  from fields;
$$;

create or replace function public.mercadolibre_sale_evidence_score(
  p_raw_data jsonb
)
returns integer
language sql
immutable
set search_path = public
as $$
  select
    public.mercadolibre_sale_lifecycle_rank(p_raw_data) * 100
    + case
        when coalesce(
          nullif(p_raw_data #>> '{parsed,return_units}', '')::numeric,
          0
        ) > 0 then 20 else 0
      end
    + case
        when coalesce(p_raw_data #>> '{parsed,return_delivered_date}', '') <> ''
          then 8 else 0
      end
    + case
        when coalesce(p_raw_data #>> '{parsed,return_review_date}', '') <> ''
          then 8 else 0
      end
    + case
        when coalesce(p_raw_data #>> '{parsed,return_result}', '') <> ''
          then 4 else 0
      end
    + case
        when coalesce(p_raw_data #>> '{parsed,return_destination}', '') <> ''
          then 4 else 0
      end
    + case
        when coalesce(p_raw_data #>> '{parsed,return_result_reason}', '') <> ''
          then 4 else 0
      end
    + case
        when coalesce(
          nullif(p_raw_data #>> '{parsed,claim_units}', '')::numeric,
          0
        ) > 0 then 4 else 0
      end;
$$;

create or replace function public.import_mercadolibre_sales_idempotent(
  p_rows jsonb,
  p_imported_by uuid,
  p_source_file_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
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
  v_file_name text;
  v_received integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_duplicate_rows integer := 0;
begin
  if p_rows is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 then
    raise exception 'No hay ventas válidas para importar.';
  end if;

  if jsonb_array_length(p_rows) > 500 then
    raise exception 'Cada bloque puede contener como máximo 500 ventas.';
  end if;

  -- Serializa importaciones concurrentes. La restricción única sigue siendo la
  -- última defensa, pero este bloqueo permite contar y comparar sin carreras.
  perform pg_advisory_xact_lock(hashtext('beyonix_mercadolibre_import'));

  for v_row in
    select value
    from jsonb_array_elements(p_rows)
  loop
    v_received := v_received + 1;
    v_raw_data := coalesce(v_row -> 'raw_data', '{}'::jsonb);
    if jsonb_typeof(v_raw_data) <> 'object' then
      raise exception 'La fila % contiene datos originales inválidos.', v_received;
    end if;

    v_sale_date := nullif(v_row ->> 'sale_date', '')::timestamptz;
    v_operation_id := nullif(btrim(v_row ->> 'operation_id'), '');
    v_order_id := nullif(btrim(v_row ->> 'order_id'), '');
    v_product_name := coalesce(
      nullif(btrim(v_row ->> 'product_name'), ''),
      'Venta Mercado Libre'
    );
    v_sku := nullif(btrim(v_row ->> 'sku'), '');
    v_quantity := greatest(coalesce((v_row ->> 'quantity')::integer, 1), 1);
    v_unit_cost := greatest(coalesce((v_row ->> 'unit_cost')::numeric, 0), 0);
    v_gross_amount := coalesce((v_row ->> 'gross_amount')::numeric, 0);
    v_fee_amount := nullif(v_row ->> 'fee_amount', '')::numeric;
    v_shipping_amount := nullif(v_row ->> 'shipping_amount', '')::numeric;
    v_net_amount := nullif(v_row ->> 'net_amount', '')::numeric;
    v_file_name := coalesce(
      nullif(btrim(v_row ->> 'source_file_name'), ''),
      nullif(btrim(p_source_file_name), '')
    );
    v_product_id := nullif(v_row ->> 'product_id', '')::bigint;
    v_variant_id := nullif(
      v_raw_data #>> '{beyonix_cost_mapping,variant_id}',
      ''
    )::bigint;

    if v_operation_id is null and v_order_id is null then
      raise exception
        'La fila % no tiene número de venta ni orden de compra.',
        v_received;
    end if;

    v_source_key := public.mercadolibre_sale_source_key(
      v_operation_id,
      v_order_id,
      v_product_name,
      v_sku,
      v_sale_date,
      v_raw_data
    );
    v_fingerprint := md5(
      (
        (v_row - 'source_file_name')
        || jsonb_build_object('raw_data', v_raw_data - 'source')
      )::text
    );

    if v_seen ? v_source_key then
      if v_seen ->> v_source_key is distinct from v_fingerprint then
        raise exception
          'El archivo contiene dos filas contradictorias para la identidad %.',
          v_source_key;
      end if;
      v_duplicate_rows := v_duplicate_rows + 1;
      continue;
    end if;
    v_seen := v_seen || jsonb_build_object(v_source_key, v_fingerprint);

    if v_product_id is not null then
      if not exists (
        select 1
        from public.productos products
        where products.id = v_product_id
      ) then
        raise exception
          'La fila % apunta a un producto inexistente.',
          v_received;
      end if;

      if v_variant_id is not null
         and not exists (
           select 1
           from public.producto_variantes variants
           where variants.id = v_variant_id
             and variants.producto_id = v_product_id
         ) then
        raise exception
          'La variante vinculada en la fila % no pertenece al producto.',
          v_received;
      end if;
    elsif v_variant_id is not null then
      raise exception
        'La fila % tiene una variante sin producto vinculado.',
        v_received;
    end if;

    select *
    into v_existing
    from public.mercadolibre_sales sales
    where sales.source_key = v_source_key
    for update;

    if not found then
      insert into public.mercadolibre_sales (
        source_key,
        sale_date,
        operation_id,
        order_id,
        product_id,
        product_name,
        sku,
        quantity,
        unit_cost,
        gross_amount,
        fee_amount,
        shipping_amount,
        net_amount,
        source_file_name,
        imported_by,
        raw_data
      )
      values (
        v_source_key,
        v_sale_date,
        v_operation_id,
        v_order_id,
        v_product_id,
        v_product_name,
        v_sku,
        v_quantity,
        v_unit_cost,
        v_gross_amount,
        v_fee_amount,
        v_shipping_amount,
        v_net_amount,
        v_file_name,
        p_imported_by,
        v_raw_data
      );
      v_inserted := v_inserted + 1;
      continue;
    end if;

    -- Una revisión física depende del UUID de esta fila. Nunca se reemplaza ni
    -- se elimina la venta; sólo se actualiza el mismo registro.
    if exists (
      select 1
      from public.inventory_return_movements movements
      where movements.mercadolibre_sale_id = v_existing.id
        and movements.received_quantity > v_quantity
    ) then
      raise exception
        'La venta % no puede reducirse por debajo de las unidades ya recibidas en devolución.',
        coalesce(v_operation_id, v_existing.operation_id);
    end if;

    if v_existing.raw_data ? 'beyonix_cost_mapping' then
      v_final_raw_data := v_raw_data || jsonb_build_object(
        'beyonix_cost_mapping',
        v_existing.raw_data -> 'beyonix_cost_mapping'
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

    -- Un reporte histórico cargado después de uno más completo no puede
    -- retroceder una cancelación, devolución o entrega ya observada.
    if public.mercadolibre_sale_evidence_score(v_final_raw_data)
       < public.mercadolibre_sale_evidence_score(v_existing.raw_data) then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    if row(
      v_existing.sale_date,
      v_existing.operation_id,
      v_existing.order_id,
      v_existing.product_id,
      v_existing.product_name,
      v_existing.sku,
      v_existing.quantity,
      v_existing.unit_cost,
      v_existing.gross_amount,
      v_existing.fee_amount,
      v_existing.shipping_amount,
      v_existing.net_amount,
      v_existing.raw_data
    ) is not distinct from row(
      v_sale_date,
      v_operation_id,
      v_order_id,
      v_product_id,
      v_product_name,
      v_sku,
      v_quantity,
      v_unit_cost,
      v_gross_amount,
      v_fee_amount,
      v_shipping_amount,
      v_net_amount,
      v_final_raw_data
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
      source_file_name = v_file_name,
      imported_by = p_imported_by,
      imported_at = now(),
      raw_data = v_final_raw_data
    where id = v_existing.id;

    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object(
    'received', v_received,
    'inserted', v_inserted,
    'updated', v_updated,
    'unchanged', v_unchanged,
    'duplicate_rows', v_duplicate_rows
  );
end;
$$;

revoke all on function public.import_mercadolibre_sales_idempotent(
  jsonb,
  uuid,
  text
) from public, anon, authenticated;

grant execute on function public.import_mercadolibre_sales_idempotent(
  jsonb,
  uuid,
  text
) to service_role;

comment on function public.import_mercadolibre_sales_idempotent(
  jsonb,
  uuid,
  text
) is
  'Importa ventas ML sin duplicar filas ni reemplazar UUID; conserva vinculaciones y devoluciones.';
