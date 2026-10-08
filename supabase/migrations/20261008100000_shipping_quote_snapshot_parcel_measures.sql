-- Cotización de envíos: snapshot histórico por orden, medidas reales de bultos
-- y recotización con bultos reales. Sólo agrega columnas/funciones nuevas;
-- no modifica datos existentes (las órdenes previas quedan con NULL = "sin
-- snapshot", y así se reportan).

-- 1. Snapshot de la cotización usada para crear la orden -------------------
-- Identidad: tarifa + recargo + ajuste comercial = shipping_cost_real (precio
-- logístico); shipping_cost_real - beneficio = shipping_cost_charged.
alter table public.ordenes
  add column if not exists shipping_provider_quote_amount numeric(12,2),
  add column if not exists shipping_markup_percent numeric(5,2),
  add column if not exists shipping_markup_amount numeric(12,2),
  add column if not exists shipping_rounding_amount numeric(12,2),
  add column if not exists shipping_benefit_amount numeric(12,2),
  add column if not exists shipping_estimate jsonb,
  -- Recotización con los bultos reales del armado (tarifa Andreani, sin
  -- recargo). Nunca se cobra al cliente: sólo calibra el estimador.
  add column if not exists shipping_parcel_quote_status text,
  add column if not exists shipping_parcel_quote_amount numeric(12,2),
  add column if not exists shipping_parcel_quote_at timestamptz,
  add column if not exists shipping_parcel_quote_request_key uuid,
  add column if not exists shipping_parcel_quote_parcels jsonb,
  add column if not exists shipping_parcel_quote_error text,
  -- Facturado por Andreani: sólo desde una fuente real (factura, liquidación,
  -- conciliación). Hoy no hay integración que lo provea: queda NULL.
  add column if not exists andreani_billed_amount numeric(12,2),
  add column if not exists andreani_billed_at timestamptz,
  add column if not exists andreani_billing_source text,
  add column if not exists andreani_billing_reference text;

alter table public.ordenes
  add constraint ordenes_shipping_provider_quote_check
    check (shipping_provider_quote_amount is null or shipping_provider_quote_amount > 0),
  add constraint ordenes_shipping_markup_percent_check
    check (shipping_markup_percent is null or shipping_markup_percent between 0 and 50),
  add constraint ordenes_shipping_markup_amount_check
    check (shipping_markup_amount is null or shipping_markup_amount >= 0),
  add constraint ordenes_shipping_benefit_amount_check
    check (shipping_benefit_amount is null or shipping_benefit_amount >= 0),
  add constraint ordenes_shipping_snapshot_complete_check
    check ((shipping_provider_quote_amount is null) = (shipping_markup_percent is null)
       and (shipping_provider_quote_amount is null) = (shipping_markup_amount is null)
       and (shipping_provider_quote_amount is null) = (shipping_rounding_amount is null)
       and (shipping_provider_quote_amount is null) = (shipping_benefit_amount is null)),
  add constraint ordenes_shipping_snapshot_identity_check
    check (shipping_provider_quote_amount is null or shipping_cost_real is null or
      shipping_provider_quote_amount + shipping_markup_amount + shipping_rounding_amount = shipping_cost_real),
  add constraint ordenes_shipping_parcel_quote_status_check
    check (shipping_parcel_quote_status is null or shipping_parcel_quote_status in ('quoted', 'failed')),
  add constraint ordenes_shipping_parcel_quote_amount_check
    check ((shipping_parcel_quote_status = 'quoted') = (shipping_parcel_quote_amount is not null)
       and (shipping_parcel_quote_amount is null or shipping_parcel_quote_amount > 0)),
  add constraint ordenes_andreani_billed_amount_check
    check (andreani_billed_amount is null or (andreani_billed_amount >= 0
       and andreani_billing_source is not null and andreani_billed_at is not null)),
  add constraint ordenes_andreani_billing_source_check
    check (andreani_billing_source is null or andreani_billing_source in ('api', 'invoice', 'settlement', 'manual'));

create index if not exists ordenes_andreani_logistics_created_idx
  on public.ordenes (created_at)
  where coalesce(shipping_provider, envio_proveedor) = 'andreani';

-- 2. Medidas reales de cada bulto ------------------------------------------
-- NULL sólo en bultos definidos antes de esta migración (legacy).
alter table public.order_package_parcels
  add column if not exists actual_weight_kg numeric(9,3),
  add column if not exists actual_length_cm numeric(6,1),
  add column if not exists actual_width_cm numeric(6,1),
  add column if not exists actual_height_cm numeric(6,1);
alter table public.order_package_parcels
  add column if not exists actual_volume_cm3 numeric(14,1)
    generated always as (actual_length_cm * actual_width_cm * actual_height_cm) stored;
alter table public.order_package_parcels
  add constraint order_package_parcels_measures_complete_check
    check ((actual_weight_kg is null) = (actual_length_cm is null)
       and (actual_weight_kg is null) = (actual_width_cm is null)
       and (actual_weight_kg is null) = (actual_height_cm is null)),
  add constraint order_package_parcels_measures_range_check
    check (actual_weight_kg is null or (actual_weight_kg > 0 and actual_weight_kg <= 1000
       and actual_length_cm > 0 and actual_length_cm <= 500
       and actual_width_cm > 0 and actual_width_cm <= 500
       and actual_height_cm > 0 and actual_height_cm <= 500));

-- 3. FINALIZAR ARMADO con medidas reales ------------------------------------
-- Mismo motor que set_order_package_parcels (mismos bloqueos, etiquetas y
-- auditoría). Con la misma cantidad sólo actualiza las medidas: las
-- etiquetas BX-PKG ya impresas siguen valiendo. Reiniciar el armado sube el
-- intento y anula las etiquetas anteriores (-R2, -R3...).
create or replace function public.set_order_package_parcels_measured(
  p_order_id bigint, p_parcels jsonb, p_actor_id uuid, p_request_key uuid)
returns public.order_packages language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype;
  v_batch_status text;
  v_base text;
  v_count integer;
  v_index integer;
  v_parcel jsonb;
  v_weight numeric;
  v_length numeric;
  v_width numeric;
  v_height numeric;
  v_existing integer;
  v_measures jsonb := '[]'::jsonb;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null then raise exception 'DISPATCH_REQUEST_KEY_REQUIRED'; end if;
  if p_parcels is null or jsonb_typeof(p_parcels) <> 'array' then
    raise exception 'DISPATCH_PARCEL_MEASURES_INVALID'; end if;
  v_count := jsonb_array_length(p_parcels);
  if v_count < 1 or v_count > 50 then raise exception 'DISPATCH_PARCEL_COUNT_INVALID'; end if;

  for v_index in 0..v_count - 1 loop
    v_parcel := p_parcels -> v_index;
    if jsonb_typeof(v_parcel) is distinct from 'object'
       or jsonb_typeof(v_parcel -> 'weightKg') is distinct from 'number'
       or jsonb_typeof(v_parcel -> 'lengthCm') is distinct from 'number'
       or jsonb_typeof(v_parcel -> 'widthCm') is distinct from 'number'
       or jsonb_typeof(v_parcel -> 'heightCm') is distinct from 'number' then
      raise exception 'DISPATCH_PARCEL_MEASURES_INVALID';
    end if;
    v_weight := round((v_parcel ->> 'weightKg')::numeric, 3);
    v_length := round((v_parcel ->> 'lengthCm')::numeric, 1);
    v_width := round((v_parcel ->> 'widthCm')::numeric, 1);
    v_height := round((v_parcel ->> 'heightCm')::numeric, 1);
    if v_weight <= 0 or v_weight > 1000 or v_length <= 0 or v_length > 500
       or v_width <= 0 or v_width > 500 or v_height <= 0 or v_height > 500 then
      raise exception 'DISPATCH_PARCEL_MEASURES_INVALID';
    end if;
    v_measures := v_measures || jsonb_build_object('index', v_index + 1, 'weightKg', v_weight,
      'lengthCm', v_length, 'widthCm', v_width, 'heightCm', v_height);
  end loop;

  perform 1 from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  if v_package.parcels_request_key = p_request_key then return v_package; end if;
  if v_package.status <> 'prepared' then raise exception 'DISPATCH_PACKAGE_NOT_PREPARED'; end if;
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

  select count(*) into v_existing from public.order_package_parcels
    where package_id = v_package.id and attempt_number = v_package.attempt_number;
  if v_package.parcel_count = v_count and v_existing = v_count then
    for v_index in 1..v_count loop
      v_parcel := v_measures -> (v_index - 1);
      update public.order_package_parcels set
        actual_weight_kg = (v_parcel ->> 'weightKg')::numeric,
        actual_length_cm = (v_parcel ->> 'lengthCm')::numeric,
        actual_width_cm = (v_parcel ->> 'widthCm')::numeric,
        actual_height_cm = (v_parcel ->> 'heightCm')::numeric
      where package_id = v_package.id and attempt_number = v_package.attempt_number
        and parcel_index = v_index;
    end loop;
  else
    delete from public.order_package_parcels
      where package_id = v_package.id and attempt_number = v_package.attempt_number;
    v_base := 'BX-PKG-' || (1000 + p_order_id)::text ||
      case when v_package.attempt_number > 1 then '-R' || v_package.attempt_number::text else '' end;
    for v_index in 1..v_count loop
      v_parcel := v_measures -> (v_index - 1);
      insert into public.order_package_parcels
        (package_id, order_id, attempt_number, parcel_index, parcel_count, barcode, created_by,
         actual_weight_kg, actual_length_cm, actual_width_cm, actual_height_cm)
      values (v_package.id, p_order_id, v_package.attempt_number, v_index, v_count,
        v_base || '-' || lpad(v_index::text, 2, '0'), p_actor_id,
        (v_parcel ->> 'weightKg')::numeric, (v_parcel ->> 'lengthCm')::numeric,
        (v_parcel ->> 'widthCm')::numeric, (v_parcel ->> 'heightCm')::numeric);
    end loop;
  end if;

  update public.order_packages set parcel_count = v_count, parcels_defined_at = now(),
    parcels_defined_by = p_actor_id, parcels_request_key = p_request_key
    where id = v_package.id returning * into v_package;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_parcels_defined',
      jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
        'parcelCount', v_count, 'parcels', v_measures));
  return v_package;
end $$;

-- 4. Resultado de la recotización con bultos reales ------------------------
-- Sólo se guarda si sigue correspondiendo a la definición vigente de bultos
-- (misma request key): un resultado tardío nunca pisa uno más nuevo.
create or replace function public.record_order_parcel_quote(
  p_order_id bigint, p_request_key uuid, p_status text, p_amount numeric,
  p_parcels jsonb, p_error text)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_updated integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'DISPATCH_FORBIDDEN'; end if;
  if p_status not in ('quoted', 'failed')
     or (p_status = 'quoted' and (p_amount is null or p_amount <= 0))
     or (p_status = 'failed' and p_amount is not null) then
    raise exception 'PARCEL_QUOTE_INVALID';
  end if;
  update public.ordenes o set
    shipping_parcel_quote_status = p_status,
    shipping_parcel_quote_amount = round(p_amount, 2),
    shipping_parcel_quote_at = now(),
    shipping_parcel_quote_request_key = p_request_key,
    shipping_parcel_quote_parcels = p_parcels,
    shipping_parcel_quote_error = left(p_error, 120)
  where o.id = p_order_id
    and exists (select 1 from public.order_packages pk
                where pk.order_id = o.id and pk.parcels_request_key = p_request_key);
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end $$;

-- 5. Resumen para Dashboard → Logística Andreani ---------------------------
-- Importes de órdenes vendidas (mismo criterio que el Dashboard financiero),
-- sumando los valores PERSISTIDOS de cada orden: nunca se recalcula con el
-- porcentaje vigente.
create or replace function public.admin_logistics_summary(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  with orders as (
    select o.*,
      (o.estado in ('pagado','approved','enviado','en_camino','visita_fallida','en_sucursal',
        'retiro_pendiente','retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
       or o.payment_status = 'approved') and o.estado <> 'cancelado' as sold
    from public.ordenes o
    where o.created_at >= p_from and o.created_at < p_to
      and coalesce(o.shipping_provider, o.envio_proveedor) = 'andreani'
  ),
  current_parcels as (
    select pk.order_id, count(p.id)::integer as parcels
    from public.order_packages pk
    join public.order_package_parcels p on p.package_id = pk.id
      and p.attempt_number = pk.attempt_number and p.parcel_count = pk.parcel_count
    where pk.order_id in (select id from orders) and pk.parcel_count is not null
    group by pk.order_id
  )
  select jsonb_build_object(
    'ordersCreated', count(*) filter (where o.andreani_envio_id is not null),
    'ordersSent', count(*) filter (where o.andreani_handed_over_at is not null
      or o.estado in ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente',
        'retiro_vencido','en_devolucion','devuelto_beyonix','entregado')),
    'ordersDelivered', count(*) filter (where o.estado = 'entregado' or o.delivered_at is not null),
    'ordersReturned', count(*) filter (where o.estado in ('en_devolucion','devuelto_beyonix')
      or exists (select 1 from public.order_claims c where c.order_id = o.id and c.cancelled_at is null)),
    'parcels', coalesce(sum(cp.parcels), 0),
    'soldOrders', count(*) filter (where o.sold),
    'snapshotOrders', count(*) filter (where o.sold and o.shipping_provider_quote_amount is not null),
    'chargedToCustomers', coalesce(sum(o.shipping_cost_charged) filter (where o.sold), 0),
    'providerQuoted', coalesce(sum(o.shipping_provider_quote_amount) filter (where o.sold), 0),
    'markupCollected', coalesce(sum(o.shipping_markup_amount) filter (where o.sold), 0),
    'roundingAdjustment', coalesce(sum(o.shipping_rounding_amount) filter (where o.sold), 0),
    'benefitAbsorbed', coalesce(sum(coalesce(o.shipping_benefit_amount,
      greatest(coalesce(o.shipping_cost_real, 0) - coalesce(o.shipping_cost_charged, 0), 0)))
      filter (where o.sold), 0),
    'parcelQuoted', coalesce(sum(o.shipping_parcel_quote_amount) filter (where o.sold
      and o.shipping_parcel_quote_status = 'quoted'), 0),
    'parcelQuotedOrders', count(*) filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'),
    'parcelQuoteDifference', coalesce(sum(o.shipping_parcel_quote_amount - o.shipping_provider_quote_amount)
      filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'
        and o.shipping_provider_quote_amount is not null), 0),
    'parcelQuoteComparableOrders', count(*) filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'
      and o.shipping_provider_quote_amount is not null),
    'comparableProviderQuoted', coalesce(sum(o.shipping_provider_quote_amount)
      filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'
        and o.shipping_provider_quote_amount is not null), 0),
    'billedByAndreani', coalesce(sum(o.andreani_billed_amount) filter (where o.sold), 0),
    'billedOrders', count(*) filter (where o.sold and o.andreani_billed_amount is not null)
  )
  from orders o
  left join current_parcels cp on cp.order_id = o.id
$$;

revoke all on function public.set_order_package_parcels_measured(bigint, jsonb, uuid, uuid),
  public.record_order_parcel_quote(bigint, uuid, text, numeric, jsonb, text),
  public.admin_logistics_summary(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.set_order_package_parcels_measured(bigint, jsonb, uuid, uuid),
  public.record_order_parcel_quote(bigint, uuid, text, numeric, jsonb, text),
  public.admin_logistics_summary(timestamptz, timestamptz)
  to service_role;
