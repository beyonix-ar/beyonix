-- Despachos simplificado: la etiqueta Andreani identifica el pedido.
--
-- Flujo operativo: pickeo completo -> envío Andreani -> etiqueta Andreani
-- impresa -> Bulto general (verificado con la etiqueta Andreani de cada
-- pedido) -> cierre (DSP) -> entrega. Sin entidades nuevas para el despacho:
--   * order_packages.identification_method suma 'andreani' (etiqueta Andreani
--     impresa para el envío vigente). 'printed'/'manual' (BX-PREP) siguen
--     siendo válidos para pedidos ya identificados: compatibilidad histórica.
--   * verify_dispatch_batch_order y resolve_cancelled_order_preparation aceptan
--     el seguimiento/envío Andreani (y, por compatibilidad, BX-PREP).
--   * add_order_to_dispatch_batch ya no exige bultos BX-PKG medidos: el envío
--     Andreani creado (dispatch_order_block_reasons) es la condición real.
--
-- Diferencias de pickeo (faltante, dañado, reducción acordada): un operador
-- reduce lo que sale de un renglón con motivo, acuerdo y diferencia de dinero
-- calculada acá (precio del renglón). No toca orden_items, pagos, factura ni
-- reintegros: la plata se resuelve manualmente y queda registrada como
-- pendiente en order_preparation_adjustments + order_audit_events.

begin;

-- 1. Seguimientos Andreani por bulto ------------------------------------------------
alter table public.ordenes
  add column if not exists andreani_bulto_numbers text[] not null default '{}';
comment on column public.ordenes.andreani_bulto_numbers is
  'Número de envío Andreani de cada bulto (mayúsculas, sin espacios). andreani_tracking guarda sólo el primero.';
create index if not exists ordenes_andreani_tracking_code_idx
  on public.ordenes (upper(btrim(andreani_tracking))) where andreani_tracking is not null;
create index if not exists ordenes_andreani_envio_code_idx
  on public.ordenes (upper(btrim(andreani_envio_id))) where andreani_envio_id is not null;
create index if not exists ordenes_andreani_bulto_numbers_idx
  on public.ordenes using gin (andreani_bulto_numbers);

-- Pedido al que pertenece una etiqueta Andreani (seguimiento, envío o bulto).
-- Los códigos BEYONIX (BX-, DSP-) nunca son Andreani. Si dos pedidos comparten
-- el código, no se adivina.
create or replace function public.order_id_from_andreani_code(p_code text)
returns bigint language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[[:space:][:cntrl:]]+', '', 'g'));
  v_ids bigint[];
begin
  if v_code = '' or length(v_code) > 64 or v_code ~ '^#?(BX-|DSP-)' then return null; end if;
  select array_agg(id order by id) into v_ids from (
    select id from public.ordenes
      where andreani_tracking is not null and upper(btrim(andreani_tracking)) = v_code
    union
    select id from public.ordenes
      where andreani_envio_id is not null and upper(btrim(andreani_envio_id)) = v_code
    union
    select id from public.ordenes where andreani_bulto_numbers @> array[v_code]
  ) matches;
  if coalesce(cardinality(v_ids), 0) > 1 then
    raise exception 'DISPATCH_ANDREANI_CODE_AMBIGUOUS'; end if;
  return v_ids[1];
end $$;

-- 2. Identificación por etiqueta Andreani ------------------------------------------
alter table public.order_packages drop constraint if exists order_packages_identification_method_check;
alter table public.order_packages add constraint order_packages_identification_method_check
  check (identification_method is null or identification_method in ('printed', 'manual', 'andreani'));
comment on column public.order_packages.identification_method is
  'Identificación física del pedido preparado (intento vigente): andreani = etiqueta Andreani impresa; printed/manual = BX-PREP (histórico).';

create or replace function public.confirm_order_andreani_label(p_order_id bigint, p_actor_id uuid)
returns public.order_packages language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order public.ordenes%rowtype;
  v_package public.order_packages%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  if v_package.status <> 'prepared' then raise exception 'DISPATCH_PACKAGE_NOT_PREPARED'; end if;
  if nullif(btrim(coalesce(v_order.andreani_envio_id, '')), '') is null
     or v_order.andreani_creation_status is distinct from 'created' then
    raise exception 'DISPATCH_SHIPMENT_PENDING' using detail = p_order_id::text; end if;
  -- Reimprimir conserva el primer registro.
  if v_package.identification_method is not null then return v_package; end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or public.order_has_active_stock_hold(p_order_id) then
    raise exception 'DISPATCH_ORDER_BLOCKED' using detail = p_order_id::text; end if;
  update public.order_packages set identification_method = 'andreani', identified_at = now(),
      identified_by = p_actor_id, identification_request_key = gen_random_uuid()
    where id = v_package.id returning * into v_package;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_andreani_label_printed',
      jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
        'envioId', v_order.andreani_envio_id, 'tracking', v_order.andreani_tracking));
  return v_package;
end $$;

-- 3. Diferencias de pickeo ---------------------------------------------------------
alter table public.order_preparation_lines
  drop constraint if exists order_preparation_lines_expected_quantity_check;
alter table public.order_preparation_lines
  add constraint order_preparation_lines_expected_quantity_check check (expected_quantity >= 0);

create table if not exists public.order_preparation_adjustments (
  id bigint generated by default as identity primary key,
  order_id bigint not null references public.ordenes(id) on delete restrict,
  package_id bigint not null references public.order_packages(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  order_item_id bigint not null references public.orden_items(id) on delete restrict,
  problem text not null check (problem in ('stock_shortage', 'damaged', 'quantity_reduction', 'other')),
  quantity_before integer not null check (quantity_before > 0),
  quantity_after integer not null check (quantity_after >= 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  difference_amount numeric(14, 2) not null check (difference_amount >= 0),
  settlement text not null check (settlement in ('manual_refund', 'customer_credit', 'no_difference')),
  agreement text not null check (length(btrim(agreement)) between 10 and 1000),
  actor_id uuid not null,
  request_key uuid not null unique,
  created_at timestamptz not null default now(),
  check (quantity_after < quantity_before)
);
comment on table public.order_preparation_adjustments is
  'Diferencias resueltas durante el pickeo (intento vigente). La diferencia de dinero se registra; reintegro/saldo se gestionan manualmente.';
create index if not exists order_preparation_adjustments_order_idx
  on public.order_preparation_adjustments(order_id);
create index if not exists order_preparation_adjustments_line_idx
  on public.order_preparation_adjustments(package_id, attempt_number, order_item_id, id desc);
alter table public.order_preparation_adjustments enable row level security;

-- Cantidad que debe salir de un renglón en el intento vigente: la última
-- diferencia registrada o lo vendido. Rearmar (nuevo intento) vuelve a lo vendido.
create or replace function public.order_preparation_effective_quantity(
  p_package_id bigint, p_attempt integer, p_order_item_id bigint, p_ordered integer)
returns integer language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select a.quantity_after from public.order_preparation_adjustments a
    where a.package_id = p_package_id and a.attempt_number = p_attempt
      and a.order_item_id = p_order_item_id
    order by a.id desc limit 1), p_ordered)
$$;

-- Igual que 20261005100000, salvo items_changed: una diferencia registrada no
-- es un cambio de artículos.
create or replace function public.dispatch_order_block_reasons(p_order_id bigint)
returns text[] language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare o public.ordenes%rowtype; v_reasons text[] := '{}';
begin
  select * into o from public.ordenes where id = p_order_id;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  if o.paid_at is null and coalesce(o.payment_confirmed_amount,0) <= 0
     and coalesce(o.payment_status,'') not in ('confirmado','approved','confirmed')
     then v_reasons := array_append(v_reasons,'not_paid'); end if;
  if o.invoice_status is distinct from 'authorized' or o.invoice_cae is null
     then v_reasons := array_append(v_reasons,'invoice_pending'); end if;
  if o.estado = 'cancelado' or o.cancelled_at is not null
     then v_reasons := array_append(v_reasons,'cancelled'); end if;
  if o.financial_status is distinct from 'payment_confirmed'
     then v_reasons := array_append(v_reasons,'financial_conflict'); end if;
  if coalesce(o.payment_status,'') in ('rechazado','rejected','approved_amount_mismatch',
     'approved_currency_mismatch','approved_stock_conflict','approved_after_cancellation',
     'auto_verified_stock_conflict')
     then v_reasons := array_append(v_reasons,'payment_reversed'); end if;
  if o.order_change_status in ('change_requested','extra_payment_pending')
     then v_reasons := array_append(v_reasons,'change'); end if;
  if o.return_status in ('solicitada','en_revision','aprobada') and o.return_resolved_at is null
     then v_reasons := array_append(v_reasons,'return'); end if;
  if exists (select 1 from public.order_claims c where c.order_id = p_order_id
             and c.status not in ('cerrado','rechazado') and c.cancelled_at is null
             and c.failure_type <> 'consulta_pedido')
     then v_reasons := array_append(v_reasons,'claim'); end if;
  if exists (select 1 from public.order_packages p where p.order_id=p_order_id
      and (exists (select 1 from public.orden_items i
        left join public.order_preparation_lines l on l.package_id=p.id and l.order_item_id=i.id
        where i.orden_id=p_order_id and (l.order_item_id is null
          or l.product_id<>i.producto_id or l.variant_id is distinct from i.variante_id
          or l.conditioned_stock_id is distinct from i.conditioned_stock_id
          or l.expected_quantity<>public.order_preparation_effective_quantity(p.id,p.attempt_number,i.id,i.cantidad)))
      or exists (select 1 from public.order_preparation_lines l
        left join public.orden_items i on i.id=l.order_item_id and i.orden_id=p_order_id
        where l.package_id=p.id and i.id is null)))
     then v_reasons := array_append(v_reasons,'items_changed'); end if;
  if lower(coalesce(o.shipping_provider,o.envio_proveedor,'')) <> 'andreani'
     then v_reasons := array_append(v_reasons,'wrong_carrier'); end if;
  if o.andreani_envio_id is null or o.andreani_creation_status is distinct from 'created'
     then v_reasons := array_append(v_reasons,'shipment_pending'); end if;
  if o.andreani_creation_status in ('claimed','reconciliation_required')
     then v_reasons := array_append(v_reasons,'shipment_uncertain'); end if;
  if o.andreani_handed_over_at is not null
     then v_reasons := array_append(v_reasons,'already_handed_over'); end if;
  if o.andreani_tracking_event_at is not null or nullif(btrim(o.tracking_number),'') is not null
     or lower(coalesce(o.andreani_estado,'')) ~ '(camino|tránsito|transito|distribución|distribucion|reparto|visita|entregado)'
     or o.estado in
     ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente',
      'retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
     then v_reasons := array_append(v_reasons,'tracking_in_circuit'); end if;
  if exists (select 1 from public.mercadopago_order_refunds r where r.order_id = p_order_id
             and r.status in ('requested','processing','needs_reconciliation'))
     then v_reasons := array_append(v_reasons,'refund_in_progress'); end if;
  return v_reasons;
end $$;

create or replace function public.adjust_order_preparation_line(
  p_order_id bigint, p_order_item_id bigint, p_quantity integer, p_problem text,
  p_settlement text, p_agreement text, p_actor_id uuid, p_request_key uuid)
returns public.order_preparation_adjustments language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_agreement text := left(btrim(coalesce(p_agreement, '')), 1000);
  v_prior public.order_preparation_adjustments%rowtype;
  v_adjustment public.order_preparation_adjustments%rowtype;
  v_order public.ordenes%rowtype;
  v_package public.order_packages%rowtype;
  v_line public.order_preparation_lines%rowtype;
  v_price numeric;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or p_quantity is null or p_quantity < 0
     or p_problem is null or p_problem not in ('stock_shortage', 'damaged', 'quantity_reduction', 'other')
     or p_settlement is null or p_settlement not in ('manual_refund', 'customer_credit', 'no_difference') then
    raise exception 'DISPATCH_ADJUSTMENT_INVALID'; end if;
  if length(v_agreement) < 10 then raise exception 'DISPATCH_ADJUSTMENT_AGREEMENT_REQUIRED'; end if;

  select * into v_prior from public.order_preparation_adjustments where request_key = p_request_key;
  if found then
    if v_prior.order_id <> p_order_id or v_prior.order_item_id <> p_order_item_id
       or v_prior.quantity_after <> p_quantity then
      raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    return v_prior;
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  -- Sólo durante el pickeo: después el envío Andreani ya declara el contenido.
  if v_package.status <> 'preparing' then raise exception 'DISPATCH_ADJUSTMENT_NOT_PICKING'; end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or public.order_has_active_stock_hold(p_order_id)
     or exists (select 1 from unnest(public.dispatch_order_block_reasons(p_order_id)) r
                where r not in ('invoice_pending', 'shipment_pending'))
     or exists (select 1 from public.dispatch_blocks where order_id = p_order_id
                and source = 'manual' and resolved_at is null) then
    raise exception 'DISPATCH_ORDER_BLOCKED' using detail = p_order_id::text; end if;

  select * into v_line from public.order_preparation_lines
    where package_id = v_package.id and order_item_id = p_order_item_id for update;
  if not found then raise exception 'DISPATCH_WRONG_ITEM'; end if;
  if p_quantity >= v_line.expected_quantity then raise exception 'DISPATCH_ADJUSTMENT_INVALID'; end if;
  if p_quantity < v_line.scanned_quantity then raise exception 'DISPATCH_ADJUSTMENT_BELOW_PICKED'; end if;
  -- Un pedido sin unidades es una cancelación, no una diferencia de pickeo.
  if p_quantity = 0 and not exists (select 1 from public.order_preparation_lines
       where package_id = v_package.id and order_item_id <> p_order_item_id and expected_quantity > 0) then
    raise exception 'DISPATCH_ADJUSTMENT_EMPTY_ORDER'; end if;

  select coalesce(precio, 0) into v_price from public.orden_items
    where id = p_order_item_id and orden_id = p_order_id;
  if not found then raise exception 'DISPATCH_WRONG_ITEM'; end if;

  insert into public.order_preparation_adjustments(order_id, package_id, attempt_number, order_item_id,
      problem, quantity_before, quantity_after, unit_price, difference_amount, settlement, agreement,
      actor_id, request_key)
    values (p_order_id, v_package.id, v_package.attempt_number, p_order_item_id, p_problem,
      v_line.expected_quantity, p_quantity, round(v_price, 2),
      round(v_price * (v_line.expected_quantity - p_quantity), 2), p_settlement, v_agreement,
      p_actor_id, p_request_key)
    returning * into v_adjustment;
  update public.order_preparation_lines set expected_quantity = p_quantity
    where package_id = v_package.id and order_item_id = p_order_item_id;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_preparation_adjusted', jsonb_build_object(
      'adjustmentId', v_adjustment.id, 'packageId', v_package.id, 'attempt', v_package.attempt_number,
      'orderItemId', p_order_item_id, 'problem', p_problem,
      'quantityBefore', v_adjustment.quantity_before, 'quantityAfter', p_quantity,
      'unitPrice', v_adjustment.unit_price, 'differenceAmount', v_adjustment.difference_amount,
      'settlement', p_settlement, 'agreement', v_agreement,
      'financial', case when p_settlement = 'no_difference' then 'none' else 'manual_settlement_pending' end));

  -- Con la diferencia, puede que ya esté todo pickeado.
  if not exists (select 1 from public.order_preparation_lines
                 where package_id = v_package.id and scanned_quantity <> expected_quantity) then
    update public.order_packages set status = 'prepared', prepared_at = now(), prepared_by = p_actor_id
      where id = v_package.id;
    insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
      values (p_order_id, 'admin', p_actor_id, 'order_prepared', jsonb_build_object('packageId', v_package.id));
  end if;
  perform public.sync_dispatch_blocks(p_order_id);
  return v_adjustment;
end $$;

-- 4. Selección: pedido preparado e identificado, sin exigir BX-PKG --------------------
create or replace function public.add_order_to_dispatch_batch(p_batch_id bigint, p_order_id bigint, p_actor_id uuid)
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
  -- El envío Andreani creado lo exige dispatch_order_block_reasons (shipment_pending).
  if v_package.identification_method is null then
    raise exception 'DISPATCH_IDENTIFICATION_PENDING' using detail = p_order_id::text; end if;
  if cardinality(public.dispatch_order_block_reasons(p_order_id)) > 0
     or exists (select 1 from public.dispatch_blocks where order_id = p_order_id and resolved_at is null)
     then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = p_order_id::text; end if;
  insert into public.dispatch_batch_items(batch_id, package_id, order_id, added_by)
    values (p_batch_id, v_package.id, p_order_id, p_actor_id) returning * into v_item;
  insert into public.dispatch_batch_events(batch_id, actor_id, action, order_id)
    values (p_batch_id, p_actor_id, 'order_added', p_order_id);
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_added_to_dispatch_batch', jsonb_build_object('batchId', p_batch_id));
  return v_item;
end $$;

-- 5. Verificación del Bulto general con la etiqueta Andreani -------------------------
create or replace function public.verify_dispatch_batch_order(
  p_batch_id bigint, p_code text, p_method text, p_actor_id uuid, p_request_key uuid,
  p_order_id bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_batch public.dispatch_batches%rowtype;
  v_item public.dispatch_batch_items%rowtype;
  v_package public.order_packages%rowtype;
  v_order public.ordenes%rowtype;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[[:space:][:cntrl:]]+', '', 'g'));
  v_match text[];
  v_order_id bigint;
  v_attempt integer;
  v_andreani boolean := false;
  v_other_code text;
  v_duplicate boolean := false;
  v_expected integer;
  v_verified integer;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or p_method is null
     or p_method not in ('scanner', 'camera', 'manual_code', 'manual_selection') then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;
  if p_method = 'manual_selection' then
    if p_order_id is null or p_order_id <= 0 then raise exception 'DISPATCH_SCAN_INVALID'; end if;
  elsif v_code = '' or length(v_code) > 64 then
    raise exception 'DISPATCH_SCAN_INVALID';
  end if;

  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;

  select * into v_item from public.dispatch_batch_items
    where batch_id = p_batch_id and verification_request_key = p_request_key;
  if found then
    if (p_method = 'manual_selection' and v_item.order_id <> p_order_id)
       or (p_method <> 'manual_selection' and v_item.verification_code <> v_code) then
      raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    v_duplicate := true;
  else
    if p_method = 'manual_selection' then
      v_order_id := p_order_id;
    else
      v_match := regexp_match(v_code, '^BX-PREP-([0-9]{1,15})(?:-R([0-9]{1,6}))?$');
      if v_match is not null then
        -- Compatibilidad: pedidos identificados con BX-PREP antes de Andreani.
        v_order_id := v_match[1]::bigint - 1000;
        v_attempt := coalesce(v_match[2]::integer, 1);
        if v_order_id <= 0 then raise exception 'DISPATCH_CODE_UNKNOWN'; end if;
      else
        v_order_id := public.order_id_from_andreani_code(v_code);
        v_andreani := v_order_id is not null;
        if not v_andreani then
          if v_code ~ '^BX-PKG-' then raise exception 'DISPATCH_VERIFY_PARCEL_CODE'; end if;
          if v_code ~ '^DSP-' then raise exception 'DISPATCH_CODE_IS_BATCH'; end if;
          if v_code ~ '^#?BX-[0-9]+$' then raise exception 'DISPATCH_VERIFY_LABEL_REQUIRED'; end if;
          if exists (select 1 from public.catalog_barcode_registry
                     where normalized_barcode = public.normalized_catalog_barcode(p_code))
             or exists (select 1 from public.catalog_sku_registry
                        where normalized_sku = public.normalized_catalog_sku(p_code)) then
            raise exception 'DISPATCH_CODE_IS_PRODUCT'; end if;
          raise exception 'DISPATCH_CODE_UNKNOWN';
        end if;
      end if;
    end if;

    select * into v_item from public.dispatch_batch_items
      where batch_id = p_batch_id and order_id = v_order_id and removed_at is null;
    if not found then
      select b.code into v_other_code from public.dispatch_batch_items i
        join public.dispatch_batches b on b.id = i.batch_id
        where i.order_id = v_order_id and i.removed_at is null;
      if v_other_code is not null then
        raise exception 'DISPATCH_PREP_OTHER_BATCH' using detail = v_other_code; end if;
      raise exception 'DISPATCH_VERIFY_NOT_EXPECTED' using detail = v_order_id::text;
    end if;

    select * into v_order from public.ordenes where id = v_order_id for update;
    select * into v_package from public.order_packages where id = v_item.package_id for update;
    if p_method = 'manual_selection' then
      v_code := coalesce(nullif(upper(btrim(v_order.andreani_tracking)), ''),
        nullif(upper(btrim(v_order.andreani_envio_id)), ''),
        public.order_preparation_barcode(v_order_id, v_package.attempt_number));
    elsif not v_andreani and v_attempt <> v_package.attempt_number then
      raise exception 'DISPATCH_PREP_STALE' using detail = v_order_id::text;
    end if;

    if v_item.verified_at is not null and v_item.verification_round = v_batch.verification_round then
      v_duplicate := true;
    else
      if v_batch.status not in ('open', 'closed') then raise exception 'DISPATCH_BATCH_CLOSED'; end if;
      if v_package.status <> 'prepared' then
        raise exception 'DISPATCH_PACKAGE_NOT_PREPARED' using detail = v_order_id::text; end if;
      if cardinality(public.dispatch_order_block_reasons(v_order_id)) > 0
         or exists (select 1 from public.dispatch_blocks where order_id = v_order_id and resolved_at is null)
         or public.order_has_active_stock_hold(v_order_id) then
        raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_order_id::text; end if;
      update public.dispatch_batch_items set verified_at = now(), verified_by = p_actor_id,
          verification_method = p_method, verification_code = v_code,
          verification_request_key = p_request_key, verification_round = v_batch.verification_round
        where id = v_item.id returning * into v_item;
      insert into public.dispatch_batch_events(batch_id, actor_id, action, order_id, metadata)
        values (p_batch_id, p_actor_id, 'order_verified', v_order_id,
          jsonb_build_object('method', p_method, 'code', v_code, 'round', v_batch.verification_round,
            'label', case when v_andreani then 'andreani' when p_method = 'manual_selection' then 'manual' else 'bx_prep' end));
    end if;
  end if;

  select count(*)::integer,
         (count(*) filter (where verified_at is not null and verification_round = v_batch.verification_round))::integer
    into v_expected, v_verified
    from public.dispatch_batch_items where batch_id = p_batch_id and removed_at is null;
  return jsonb_build_object('orderId', v_item.order_id, 'batchItemId', v_item.id,
    'code', v_item.verification_code, 'method', v_item.verification_method,
    'duplicate', v_duplicate, 'expected', v_expected, 'verified', v_verified,
    'batchCode', v_batch.code);
end $$;

-- 6. Retiro físico de un cancelado: también con la etiqueta Andreani -----------------
-- Igual que 20261016130000 (sin restitución de saldo) + lectura Andreani.
create or replace function public.resolve_cancelled_order_preparation(
  p_code text, p_actor_id uuid, p_request_key uuid, p_expected_order_id bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_match text[];
  v_order_id bigint;
  v_attempt integer;
  v_order_code boolean := false;
  v_andreani boolean := false;
  v_order public.ordenes%rowtype;
  v_parcel public.order_package_parcels%rowtype;
  v_hold public.order_cancellation_holds%rowtype;
  v_batch public.dispatch_batches%rowtype;
  v_item public.dispatch_batch_items%rowtype;
  v_product_id bigint;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or v_code = '' or length(v_code) > 64 then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;

  select * into v_hold from public.order_cancellation_holds where resolution_request_key = p_request_key;
  if found then
    if v_hold.resolution_code <> v_code then raise exception 'DISPATCH_SCAN_KEY_CONFLICT'; end if;
    return jsonb_build_object('orderId', v_hold.order_id, 'units', v_hold.units, 'pickedUnits', v_hold.picked_units,
      'items', v_hold.items, 'batchId', v_hold.resolution_batch_id, 'duplicate', true, 'alreadyResolved', true);
  end if;

  v_match := regexp_match(v_code, '^BX-PREP-([0-9]+)(?:-R([0-9]+))?$');
  if v_match is not null then
    v_order_id := v_match[1]::bigint - 1000;
    v_attempt := coalesce(v_match[2]::integer, 1);
  else
    v_match := regexp_match(v_code, '^#?BX-([0-9]+)$');
    if v_match is not null then
      v_order_id := v_match[1]::bigint - 1000;
      v_order_code := true;
    else
      v_order_id := public.order_id_from_andreani_code(v_code);
      v_andreani := v_order_id is not null;
      if not v_andreani then
        select * into v_parcel from public.order_package_parcels where barcode = v_code;
        if found then
          v_order_id := v_parcel.order_id;
          v_attempt := v_parcel.attempt_number;
        elsif v_code ~ '^DSP-' then raise exception 'DISPATCH_CODE_IS_BATCH';
        elsif v_code ~ '^BX-PKG-' then raise exception 'DISPATCH_PARCEL_UNKNOWN';
        elsif exists (select 1 from public.catalog_barcode_registry
                      where normalized_barcode = public.normalized_catalog_barcode(p_code))
           or exists (select 1 from public.catalog_sku_registry
                      where normalized_sku = public.normalized_catalog_sku(p_code)) then
          raise exception 'DISPATCH_RESOLUTION_CODE_IS_PRODUCT';
        else raise exception 'DISPATCH_CODE_UNKNOWN';
        end if;
      end if;
    end if;
  end if;
  if v_order_id is null or v_order_id <= 0 then raise exception 'DISPATCH_CODE_UNKNOWN'; end if;
  if p_expected_order_id is not null and p_expected_order_id <> v_order_id then
    raise exception 'DISPATCH_RESOLUTION_WRONG_ORDER' using detail = v_order_id::text; end if;

  select * into v_order from public.ordenes where id = v_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_hold from public.order_cancellation_holds
    where order_id = v_order_id and resolved_at is null for update;
  if not found then
    select * into v_hold from public.order_cancellation_holds
      where order_id = v_order_id order by resolved_at desc nulls last limit 1;
    if found then
      return jsonb_build_object('orderId', v_order_id, 'units', v_hold.units, 'pickedUnits', v_hold.picked_units,
        'items', v_hold.items, 'batchId', v_hold.resolution_batch_id, 'duplicate', true, 'alreadyResolved', true);
    end if;
    raise exception 'DISPATCH_RESOLUTION_NOT_REQUIRED' using detail = v_order_id::text;
  end if;
  -- Un pedido preparado con etiqueta (Andreani o BX-PREP histórica) se retira
  -- escaneándola; sin etiqueta todavía, alcanza su número de pedido.
  if v_order_code and v_hold.prepared
     and (nullif(btrim(coalesce(v_order.andreani_envio_id, '')), '') is not null
       or exists (select 1 from public.order_packages
                  where order_id = v_order_id and identification_method is not null)) then
    raise exception 'DISPATCH_RESOLUTION_LABEL_REQUIRED'; end if;
  if not v_order_code and not v_andreani and v_attempt <> v_hold.attempt_number then
    raise exception 'DISPATCH_PARCEL_STALE' using detail = v_order_id::text; end if;

  select * into v_item from public.dispatch_batch_items where order_id = v_order_id and removed_at is null;
  if found then
    select * into v_batch from public.dispatch_batches where id = v_item.batch_id;
    perform public.remove_order_from_dispatch_batch(v_item.batch_id, v_order_id, p_actor_id,
      'Pedido cancelado retirado físicamente del lote (escaneo ' || v_code || ')');
  end if;

  update public.order_cancellation_holds set resolved_at = now(), resolved_by = p_actor_id,
      resolution_request_key = p_request_key, resolution_code = v_code,
      resolution_batch_id = v_item.batch_id
    where id = v_hold.id returning * into v_hold;

  for v_product_id in
    select distinct (item->>'productId')::bigint from jsonb_array_elements(v_hold.items) item
      order by 1
  loop
    perform public.refresh_inventory_stock(v_product_id);
  end loop;
  perform public.sync_dispatch_blocks(v_order_id);
  -- Sin saldo, dinero ni estado financiero: eso es siempre una acción de Admin.

  insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
    values (v_order_id, 'admin', p_actor_id, 'dispatch_cancellation_physically_resolved',
      'requires_physical_resolution', 'physically_returned',
      jsonb_build_object('holdId', v_hold.id, 'code', v_code, 'batchId', v_item.batch_id,
        'batchCode', v_batch.code, 'pickedUnits', v_hold.picked_units, 'prepared', v_hold.prepared,
        'financial', 'manual_refund_required')),
      (v_order_id, 'admin', p_actor_id, 'dispatch_cancellation_stock_restored',
      'stock_held', 'stock_restored',
      jsonb_build_object('holdId', v_hold.id, 'units', v_hold.units, 'items', v_hold.items));

  return jsonb_build_object('orderId', v_order_id, 'units', v_hold.units, 'pickedUnits', v_hold.picked_units,
    'items', v_hold.items, 'batchId', v_item.batch_id, 'batchCode', v_batch.code,
    'duplicate', false, 'alreadyResolved', false);
end $$;

revoke all on function public.order_id_from_andreani_code(text),
  public.confirm_order_andreani_label(bigint, uuid),
  public.order_preparation_effective_quantity(bigint, integer, bigint, integer),
  public.dispatch_order_block_reasons(bigint),
  public.adjust_order_preparation_line(bigint, bigint, integer, text, text, text, uuid, uuid),
  public.add_order_to_dispatch_batch(bigint, bigint, uuid),
  public.verify_dispatch_batch_order(bigint, text, text, uuid, uuid, bigint),
  public.resolve_cancelled_order_preparation(text, uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on table public.order_preparation_adjustments from public, anon, authenticated;
grant execute on function public.order_id_from_andreani_code(text),
  public.confirm_order_andreani_label(bigint, uuid),
  public.order_preparation_effective_quantity(bigint, integer, bigint, integer),
  public.dispatch_order_block_reasons(bigint),
  public.adjust_order_preparation_line(bigint, bigint, integer, text, text, text, uuid, uuid),
  public.add_order_to_dispatch_batch(bigint, bigint, uuid),
  public.verify_dispatch_batch_order(bigint, text, text, uuid, uuid, bigint),
  public.resolve_cancelled_order_preparation(text, uuid, uuid, bigint)
  to service_role;
grant select on table public.order_preparation_adjustments to service_role;

notify pgrst, 'reload schema';

commit;
