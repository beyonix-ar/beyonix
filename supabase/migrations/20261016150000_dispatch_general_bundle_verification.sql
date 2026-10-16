-- Bulto general verificado por pedido preparado (BX-PREP) e identificación
-- física obligatoria. Reutiliza el modelo existente, sin entidades nuevas:
--   * pedido preparado  = order_packages (status 'prepared'), código BX-PREP
--     derivado de pedido + intento (order_preparation_barcode);
--   * Bulto general     = dispatch_batches (DSP-…) + dispatch_batch_items;
--   * BX-PKG            = order_package_parcels: sigue siendo el bulto físico
--     individual (medidas/peso Andreani), ya no es el control del Bulto general.
--
-- Cambios:
--   1. order_packages registra la identificación física del pedido preparado
--      (etiqueta BX-PREP impresa y colocada, o código escrito a mano). Vale
--      para el intento vigente: rearmar la anula. Sin ella el pedido no entra
--      a un Bulto general.
--   2. dispatch_batch_items distingue ESPERADO (fila activa) de VERIFICADO
--      (verified_*): un BX-PREP por pedido, por scanner, cámara, tipeo/pegado o
--      selección manual explícita. Todos terminan en verify_dispatch_batch_order.
--   3. Cerrar y entregar exigen todos los pedidos esperados verificados en la
--      ronda vigente. Si se retira un pedido de un Bulto general cerrado
--      (p. ej. cancelación resuelta físicamente), la composición cambió: la
--      ronda avanza y los pedidos restantes se vuelven a validar antes de la
--      entrega. El corte financiero (prepared_at/closed_at) no cambia.
--   4. Compatibilidad histórica, sin inventar verificaciones:
--      * 'legacy_parcels' SÓLO para ítems con escaneos BX-PKG reales
--        (dispatch_batch_parcel_scans); el código guardado son esas etiquetas.
--      * Un lote ya cerrado/entregado al aplicar la migración queda con
--        verification_required = false: sus pedidos sin escaneos siguen sin
--        verificar (no aparecen como verificados) y el lote no se bloquea
--        artificialmente. Si después se le retira un pedido, vuelve a exigir
--        verificación (la composición cambió).
--      * Lotes abiertos y nuevos exigen BX-PREP para cerrar y entregar.

begin;

-- 1. Identificación física del pedido preparado -----------------------------------
alter table public.order_packages
  add column if not exists identification_method text,
  add column if not exists identified_at timestamptz,
  add column if not exists identified_by uuid,
  add column if not exists identification_request_key uuid;
alter table public.order_packages
  add constraint order_packages_identification_method_check
    check (identification_method is null or identification_method in ('printed', 'manual')),
  add constraint order_packages_identification_pair_check
    check ((identification_method is null) = (identified_at is null)
       and (identification_method is null) = (identified_by is null)
       and (identification_method is null) = (identification_request_key is null)),
  add constraint order_packages_identification_prepared_check
    check (identification_method is null or status = 'prepared');
comment on column public.order_packages.identification_method is
  'Identificación física del pedido preparado (intento vigente): printed = etiqueta BX-PREP impresa y colocada; manual = código BX-PREP escrito a mano y confirmado.';

-- Rearmar anula la identificación (el BX-PREP cambia a -R2); una vez
-- registrada no se reescribe por fuera de ese camino.
create or replace function public.sync_package_identification()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.attempt_number <> old.attempt_number or new.status <> 'prepared' then
    new.identification_method := null;
    new.identified_at := null;
    new.identified_by := null;
    new.identification_request_key := null;
    return new;
  end if;
  if old.identification_method is not null
     and (new.identification_method, new.identified_at, new.identified_by, new.identification_request_key)
         is distinct from (old.identification_method, old.identified_at, old.identified_by, old.identification_request_key) then
    raise exception 'DISPATCH_IDENTIFICATION_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger sync_package_identification before update on public.order_packages
  for each row execute function public.sync_package_identification();

create or replace function public.confirm_order_physical_identification(
  p_order_id bigint, p_code text, p_method text, p_actor_id uuid, p_request_key uuid)
returns public.order_packages language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_package public.order_packages%rowtype;
  v_order public.ordenes%rowtype;
  -- Lector, cámara o pegado: sin espacios ni caracteres de control (BX-PREP no los tiene).
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[[:space:][:cntrl:]]+', '', 'g'));
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if p_request_key is null or p_method is null or p_method not in ('printed', 'manual') then
    raise exception 'DISPATCH_SCAN_INVALID'; end if;
  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ORDER_NOT_FOUND'; end if;
  select * into v_package from public.order_packages where order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_PREPARATION_NOT_STARTED'; end if;
  if v_package.identification_request_key = p_request_key then return v_package; end if;
  if v_package.status <> 'prepared' then raise exception 'DISPATCH_PACKAGE_NOT_PREPARED'; end if;
  -- Siempre el código vigente: una etiqueta de un intento anterior no identifica.
  if v_code <> public.order_preparation_barcode(p_order_id, v_package.attempt_number) then
    raise exception 'DISPATCH_PREP_STALE' using detail = p_order_id::text; end if;
  -- Ya identificado: se conserva el primer registro (reimprimir no lo cambia).
  if v_package.identification_method is not null then return v_package; end if;
  if v_order.estado = 'cancelado' or v_order.cancelled_at is not null
     or public.order_has_active_stock_hold(p_order_id) then
    raise exception 'DISPATCH_ORDER_BLOCKED' using detail = p_order_id::text; end if;
  update public.order_packages set identification_method = p_method, identified_at = now(),
      identified_by = p_actor_id, identification_request_key = p_request_key
    where id = v_package.id returning * into v_package;
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_physical_identification_confirmed',
      jsonb_build_object('packageId', v_package.id, 'attempt', v_package.attempt_number,
        'method', p_method, 'code', v_code));
  return v_package;
end $$;

-- 2. Verificación por pedido dentro del Bulto general ------------------------------
alter table public.dispatch_batches
  add column if not exists verification_round integer not null default 1,
  add column if not exists verification_required boolean not null default true;
alter table public.dispatch_batches
  add constraint dispatch_batches_verification_round_check check (verification_round > 0);
comment on column public.dispatch_batches.verification_required is
  'false sólo para Bultos generales ya cerrados/entregados antes de la verificación por BX-PREP (20261016150000): compatibles, pero sin verificación inventada.';

alter table public.dispatch_batch_items
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid,
  add column if not exists verification_method text,
  add column if not exists verification_code text,
  add column if not exists verification_request_key uuid,
  add column if not exists verification_round integer;
alter table public.dispatch_batch_items
  add constraint dispatch_batch_items_verification_method_check
    check (verification_method is null or verification_method in
      ('scanner', 'camera', 'manual_code', 'manual_selection', 'legacy_parcels')),
  add constraint dispatch_batch_items_verification_pair_check
    check ((verified_at is null) = (verified_by is null)
       and (verified_at is null) = (verification_method is null)
       and (verified_at is null) = (verification_code is null)
       and (verified_at is null) = (verification_round is null)
       and (verification_request_key is null or verified_at is not null)),
  add constraint dispatch_batch_items_verification_code_check
    check (verification_code is null or length(verification_code) between 1 and 1000);
create unique index dispatch_batch_items_verification_key_unique
  on public.dispatch_batch_items(batch_id, verification_request_key)
  where verification_request_key is not null;
comment on column public.dispatch_batch_items.verified_at is
  'Pedido esperado físicamente verificado en el Bulto general (válido sólo si verification_round = dispatch_batches.verification_round).';

alter table public.dispatch_batch_events drop constraint if exists dispatch_batch_events_action_check;
alter table public.dispatch_batch_events add constraint dispatch_batch_events_action_check
  check (action in ('created', 'order_added', 'closed', 'order_removed', 'handed_over',
    'order_verified', 'revalidation_required'));

-- La pertenencia sigue siendo inmutable salvo el retiro y, ahora, la
-- verificación (una vez por ronda, sólo sobre pedidos activos).
create or replace function public.guard_dispatch_membership()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_status text; v_round integer;
begin
  select status, verification_round into v_status, v_round
    from public.dispatch_batches where id = new.batch_id for update;
  if tg_op = 'INSERT' then
    if v_status <> 'open' or new.verified_at is not null
       or not exists (select 1 from public.order_packages
        where id = new.package_id and order_id = new.order_id and status = 'prepared'
          and identification_method is not null) then
      raise exception 'DISPATCH_MEMBERSHIP_INVALID'; end if;
    return new;
  end if;
  if (new.batch_id, new.package_id, new.order_id, new.added_by, new.added_at)
     is distinct from (old.batch_id, old.package_id, old.order_id, old.added_by, old.added_at) then
    raise exception 'DISPATCH_MEMBERSHIP_IMMUTABLE';
  end if;
  if old.removed_at is null and new.removed_at is not null then
    if v_status = 'handed_over' or length(btrim(coalesce(new.removal_reason, ''))) < 10
       or (new.verified_at, new.verified_by, new.verification_method, new.verification_code,
           new.verification_request_key, new.verification_round)
          is distinct from (old.verified_at, old.verified_by, old.verification_method, old.verification_code,
           old.verification_request_key, old.verification_round) then
      raise exception 'DISPATCH_REMOVAL_INVALID'; end if;
  elsif old.removed_at is null and new.removed_at is null and new.removed_by is null
        and new.removal_reason is null and new.verified_at is not null
        and (old.verified_at is null or old.verification_round is distinct from v_round) then
    if v_status not in ('open', 'closed') or new.verification_round is distinct from v_round then
      raise exception 'DISPATCH_VERIFICATION_INVALID'; end if;
  elsif row(new.*) is distinct from row(old.*) then
    raise exception 'DISPATCH_MEMBERSHIP_IMMUTABLE';
  end if;
  return new;
end $$;

-- Compatibilidad: sólo hay verificación histórica donde hubo escaneos BX-PKG
-- reales. En un lote cerrado/entregado vale lo escaneado (el cierre de
-- entonces ya exigía todos los bultos); en uno abierto, sólo si estaban todos.
alter table public.dispatch_batch_items disable trigger guard_dispatch_membership;
with legacy as (
  select i.id,
    max(s.scanned_at) as verified_at,
    (array_agg(s.scanned_by order by s.scanned_at desc))[1] as verified_by,
    string_agg(p.barcode, ',' order by p.parcel_index) as code
  from public.dispatch_batch_items i
  join public.dispatch_batches b on b.id = i.batch_id
  join public.dispatch_batch_parcel_scans s on s.batch_item_id = i.id
  join public.order_package_parcels p on p.id = s.parcel_id
  where i.verified_at is null
    and (b.status in ('closed', 'handed_over')
      or (i.removed_at is null and public.dispatch_item_missing_parcels(i.id) = 0))
  group by i.id
)
update public.dispatch_batch_items i
  set verified_at = legacy.verified_at, verified_by = legacy.verified_by,
      verification_method = 'legacy_parcels', verification_code = left(legacy.code, 1000),
      verification_round = 1
  from legacy where legacy.id = i.id;
alter table public.dispatch_batch_items enable trigger guard_dispatch_membership;

-- Ya finalizados: compatibles sin exigir (ni simular) la verificación nueva.
update public.dispatch_batches set verification_required = false
  where status in ('closed', 'handed_over');

-- 3. Selección: pedido preparado, con bultos (medidas Andreani) e identificado ------
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
  if v_package.parcel_count is null then
    raise exception 'DISPATCH_PARCELS_PENDING' using detail = p_order_id::text; end if;
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

-- 4. Verificación física: UN BX-PREP por pedido ----------------------------------
-- Scanner, cámara, tipeo/pegado (manual_code) y selección manual explícita
-- (manual_selection) pasan por esta misma función. Idempotente por request_key;
-- un pedido ya verificado en la ronda vigente devuelve duplicate sin efectos.
create or replace function public.verify_dispatch_batch_order(
  p_batch_id bigint, p_code text, p_method text, p_actor_id uuid, p_request_key uuid,
  p_order_id bigint default null)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_batch public.dispatch_batches%rowtype;
  v_item public.dispatch_batch_items%rowtype;
  v_package public.order_packages%rowtype;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[[:space:][:cntrl:]]+', '', 'g'));
  v_match text[];
  v_order_id bigint;
  v_attempt integer;
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
      if v_match is null then
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
      v_order_id := v_match[1]::bigint - 1000;
      v_attempt := coalesce(v_match[2]::integer, 1);
      if v_order_id <= 0 then raise exception 'DISPATCH_CODE_UNKNOWN'; end if;
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

    perform 1 from public.ordenes where id = v_order_id for update;
    select * into v_package from public.order_packages where id = v_item.package_id for update;
    if p_method = 'manual_selection' then
      v_code := public.order_preparation_barcode(v_order_id, v_package.attempt_number);
    elsif v_attempt <> v_package.attempt_number then
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
          jsonb_build_object('method', p_method, 'code', v_code, 'round', v_batch.verification_round));
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

-- 5. Retiro: en un Bulto general cerrado la composición cambió -> revalidar --------
create or replace function public.remove_order_from_dispatch_batch(
  p_batch_id bigint, p_order_id bigint, p_actor_id uuid, p_reason text)
returns public.dispatch_batch_items language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_item public.dispatch_batch_items%rowtype;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'DISPATCH_REASON_REQUIRED'; end if;
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  select * into v_item from public.dispatch_batch_items
    where batch_id = p_batch_id and order_id = p_order_id for update;
  if not found then raise exception 'DISPATCH_ITEM_NOT_FOUND'; end if;
  if v_item.removed_at is not null then return v_item; end if;
  if v_batch.status = 'handed_over' then raise exception 'DISPATCH_ALREADY_HANDED_OVER'; end if;
  perform 1 from public.ordenes where id = p_order_id for update;
  update public.dispatch_batch_items set removed_by = p_actor_id, removed_at = now(),
      removal_reason = left(btrim(p_reason), 1000)
    where id = v_item.id returning * into v_item;
  insert into public.dispatch_batch_events(batch_id, actor_id, action, order_id, metadata)
    values (p_batch_id, p_actor_id, 'order_removed', p_order_id, jsonb_build_object('reason', v_item.removal_reason));
  insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
    values (p_order_id, 'admin', p_actor_id, 'order_removed_from_dispatch_batch',
      jsonb_build_object('batchId', p_batch_id, 'reason', v_item.removal_reason));
  if v_batch.status = 'closed' then
    update public.dispatch_batches set verification_round = verification_round + 1,
        verification_required = true
      where id = p_batch_id returning * into v_batch;
    insert into public.dispatch_batch_events(batch_id, actor_id, action, order_id, metadata)
      values (p_batch_id, p_actor_id, 'revalidation_required', p_order_id,
        jsonb_build_object('round', v_batch.verification_round));
  end if;
  return v_item;
end $$;

-- 6. Cierre y entrega: todos los pedidos esperados verificados --------------------
create or replace function public.close_dispatch_batch(p_batch_id bigint, p_actor_id uuid)
returns public.dispatch_batches language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_item record;
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status in ('closed', 'handed_over') then return v_batch; end if;
  if not exists (select 1 from public.dispatch_batch_items where batch_id = p_batch_id and removed_at is null)
     then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  for v_item in select id, order_id, package_id, verified_at, verification_round
    from public.dispatch_batch_items
    where batch_id = p_batch_id and removed_at is null order by order_id loop
    perform 1 from public.ordenes where id = v_item.order_id for update;
    if cardinality(public.dispatch_order_block_reasons(v_item.order_id)) > 0
       or exists (select 1 from public.dispatch_blocks where order_id = v_item.order_id and resolved_at is null)
       or not exists (select 1 from public.order_packages
                      where id = v_item.package_id and order_id = v_item.order_id and status = 'prepared')
       then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_item.order_id::text; end if;
    if v_item.verified_at is null or v_item.verification_round is distinct from v_batch.verification_round then
      raise exception 'DISPATCH_ORDERS_UNVERIFIED' using detail = v_item.order_id::text; end if;
  end loop;
  update public.dispatch_batches set status = 'closed', closed_at = now(), closed_by = p_actor_id
    where id = p_batch_id returning * into v_batch;
  insert into public.dispatch_batch_events(batch_id, actor_id, action)
    values (p_batch_id, p_actor_id, 'closed');
  return v_batch;
end $$;

create or replace function public.hand_over_dispatch_batch(p_batch_id bigint, p_actor_id uuid)
returns public.dispatch_batches language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_batch public.dispatch_batches%rowtype; v_item record; v_at timestamptz := now();
begin
  perform public.assert_dispatch_operator(p_actor_id);
  select * into v_batch from public.dispatch_batches where id = p_batch_id for update;
  if not found then raise exception 'DISPATCH_BATCH_NOT_FOUND'; end if;
  if v_batch.status = 'handed_over' then return v_batch; end if;
  if v_batch.status <> 'closed' then raise exception 'DISPATCH_BATCH_NOT_CLOSED'; end if;
  if not exists (select 1 from public.dispatch_batch_items where batch_id = p_batch_id and removed_at is null)
     then raise exception 'DISPATCH_BATCH_EMPTY'; end if;
  -- Lock every order before checking. Cancellation and refund RPCs lock the same rows.
  for v_item in select i.id, i.order_id, i.package_id, i.verified_at, i.verification_round
    from public.dispatch_batch_items i
    where i.batch_id = p_batch_id and i.removed_at is null order by i.order_id loop
    perform 1 from public.ordenes where id = v_item.order_id for update;
    if cardinality(public.dispatch_order_block_reasons(v_item.order_id)) > 0
       or exists (select 1 from public.dispatch_blocks where order_id = v_item.order_id and resolved_at is null)
       or not exists (select 1 from public.order_packages
                      where id = v_item.package_id and order_id = v_item.order_id and status = 'prepared')
       then raise exception 'DISPATCH_ORDER_BLOCKED' using detail = v_item.order_id::text; end if;
    if v_batch.verification_required
       and (v_item.verified_at is null or v_item.verification_round is distinct from v_batch.verification_round) then
      raise exception 'DISPATCH_ORDERS_UNVERIFIED' using detail = v_item.order_id::text; end if;
  end loop;
  update public.dispatch_batches set status = 'handed_over', handed_over_by = p_actor_id,
    handed_over_at = v_at where id = p_batch_id returning * into v_batch;
  insert into public.dispatch_batch_events(batch_id, actor_id, action)
    values (p_batch_id, p_actor_id, 'handed_over');
  for v_item in select order_id from public.dispatch_batch_items
    where batch_id = p_batch_id and removed_at is null order by order_id loop
    update public.ordenes set andreani_handed_over_at = v_at,
      andreani_handed_over_by = p_actor_id, andreani_handed_over_batch_id = p_batch_id
      where id = v_item.order_id and andreani_handed_over_at is null;
    if not found then raise exception 'DISPATCH_ORDER_ALREADY_HANDED_OVER'; end if;
    insert into public.order_audit_events(order_id, actor_type, actor_id, action, metadata)
      values (v_item.order_id, 'admin', p_actor_id, 'order_handed_over_to_andreani',
        jsonb_build_object('batchId', p_batch_id, 'batchCode', v_batch.code));
  end loop;
  return v_batch;
end $$;

revoke all on function public.sync_package_identification(),
  public.guard_dispatch_membership(),
  public.confirm_order_physical_identification(bigint, text, text, uuid, uuid),
  public.verify_dispatch_batch_order(bigint, text, text, uuid, uuid, bigint),
  public.add_order_to_dispatch_batch(bigint, bigint, uuid),
  public.remove_order_from_dispatch_batch(bigint, bigint, uuid, text),
  public.close_dispatch_batch(bigint, uuid),
  public.hand_over_dispatch_batch(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.confirm_order_physical_identification(bigint, text, text, uuid, uuid),
  public.verify_dispatch_batch_order(bigint, text, text, uuid, uuid, bigint),
  public.add_order_to_dispatch_batch(bigint, bigint, uuid),
  public.remove_order_from_dispatch_batch(bigint, bigint, uuid, text),
  public.close_dispatch_batch(bigint, uuid),
  public.hand_over_dispatch_batch(bigint, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
