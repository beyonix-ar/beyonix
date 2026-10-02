-- Eventos programados (Admin → Eventos), sobre la tabla existente
-- product_bulk_events (los eventos manuales previos siguen funcionando):
--   * "Cambio programado de precios": misma acción que el Editor masivo, a
--     una fecha/hora; opcionalmente se revierte al terminar restaurando los
--     valores EXACTOS previos (snapshot por producto, nunca recalculando).
--   * "Financiación promocional": cambia la política global de precio
--     financiado (site_settings.financed_price_policy) entre inicio y fin y
--     al terminar vuelve a la política que había al empezar.
--
-- Cada ejecución (aplicar / restaurar) es UNA transacción: o se aplica
-- completa o no cambia nada. Son idempotentes: sólo actúan desde el estado
-- esperado (programado → activo → finalizado), así una segunda corrida del
-- scheduler no duplica cambios. El cálculo de precios NO vive acá: lo hace
-- el núcleo compartido con el Editor masivo (lib/pricing/bulk-price-engine.ts)
-- y estas funciones verifican que los precios no hayan cambiado entre el
-- cálculo y la escritura.

alter table public.product_bulk_events
  add column if not exists event_type text not null default 'price_change',
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists financing_policy text,
  add column if not exists previous_financing_policy text,
  add column if not exists executed_at timestamptz,
  add column if not exists restored_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists failed_phase text,
  add column if not exists last_error text,
  add column if not exists result jsonb;

-- Eventos sólo por las rutas Admin/cron (service_role). Las filas históricas
-- siguen legibles a través de esas rutas; el navegador no las muta directo.
alter table public.product_bulk_events enable row level security;
revoke insert, update, delete on public.product_bulk_events from public, anon, authenticated;
grant select, insert, update, delete on public.product_bulk_events to service_role;

-- La financiación promocional no tiene acción de precios.
alter table public.product_bulk_events alter column action_kind drop not null;

alter table public.product_bulk_events drop constraint if exists product_bulk_events_action_kind_check;
alter table public.product_bulk_events add constraint product_bulk_events_action_kind_check
  check (action_kind is null or action_kind = any (array[
    'discount_percent', 'price_decrease_percent', 'price_increase_percent',
    'price_decrease_amount', 'price_increase_amount', 'clear_offer', 'installments'
  ]));
alter table public.product_bulk_events drop constraint if exists product_bulk_events_value_check;
alter table public.product_bulk_events add constraint product_bulk_events_value_check
  check (
    (action_kind in ('discount_percent', 'price_decrease_percent', 'price_increase_percent') and value between 1 and 99)
    or (action_kind in ('price_decrease_amount', 'price_increase_amount') and value > 0 and value <= 99999999.99)
    or (action_kind not in ('discount_percent', 'price_decrease_percent', 'price_increase_percent', 'price_decrease_amount', 'price_increase_amount') and (value is null or value between 1 and 99))
    or action_kind is null
  );

alter table public.product_bulk_events drop constraint if exists product_bulk_events_status_check;
alter table public.product_bulk_events add constraint product_bulk_events_status_check
  check (status = any (array['draft', 'active', 'scheduled', 'finished', 'cancelled', 'error']));

alter table public.product_bulk_events drop constraint if exists product_bulk_events_event_type_check;
alter table public.product_bulk_events add constraint product_bulk_events_event_type_check
  check (event_type = any (array['price_change', 'financing_policy']));

alter table public.product_bulk_events drop constraint if exists product_bulk_events_action_kind_required_check;
alter table public.product_bulk_events add constraint product_bulk_events_action_kind_required_check
  check (event_type <> 'price_change' or action_kind is not null);

alter table public.product_bulk_events drop constraint if exists product_bulk_events_financing_policy_check;
alter table public.product_bulk_events add constraint product_bulk_events_financing_policy_check
  check (
    (financing_policy is null or financing_policy = any (array['cover_costs', 'same_as_cash']))
    and (previous_financing_policy is null or previous_financing_policy = any (array['cover_costs', 'same_as_cash']))
  );

alter table public.product_bulk_events drop constraint if exists product_bulk_events_failed_phase_check;
alter table public.product_bulk_events add constraint product_bulk_events_failed_phase_check
  check (failed_phase is null or failed_phase = any (array['apply', 'restore']));

alter table public.product_bulk_events drop constraint if exists product_bulk_events_schedule_check;
alter table public.product_bulk_events add constraint product_bulk_events_schedule_check
  check (ends_at is null or (starts_at is not null and ends_at > starts_at));

-- La financiación promocional es siempre temporal: inicio, fin y política.
alter table public.product_bulk_events drop constraint if exists product_bulk_events_financing_shape_check;
alter table public.product_bulk_events add constraint product_bulk_events_financing_shape_check
  check (
    event_type <> 'financing_policy'
    or (starts_at is not null and ends_at is not null and financing_policy is not null)
  );

create index if not exists product_bulk_events_due_start_idx
  on public.product_bulk_events (status, starts_at) where starts_at is not null;
create index if not exists product_bulk_events_due_end_idx
  on public.product_bulk_events (status, ends_at) where ends_at is not null;

-- Snapshot por producto de cada evento de precios: valores EXACTOS antes y
-- después. Histórico inmutable (no se borra con el evento: on delete restrict).
create table if not exists public.product_price_event_snapshots (
  id bigserial primary key,
  event_id uuid not null references public.product_bulk_events (id) on delete restrict,
  product_id bigint not null,
  product_name text,
  action_kind text not null,
  value numeric,
  precio_before numeric(10, 2) not null,
  precio_anterior_before numeric(10, 2),
  descuento_before integer,
  precio_after numeric(10, 2) not null check (precio_after >= 1),
  precio_anterior_after numeric(10, 2),
  descuento_after integer,
  applied_at timestamptz not null,
  restored_at timestamptz,
  restore_result text check (
    restore_result is null
    or restore_result = any (array['restored', 'kept_manual_change', 'product_missing'])
  ),
  unique (event_id, product_id)
);

create index if not exists product_price_event_snapshots_product_idx
  on public.product_price_event_snapshots (product_id);

alter table public.product_price_event_snapshots enable row level security;
revoke all on table public.product_price_event_snapshots from public, anon, authenticated;
grant select, insert, update on table public.product_price_event_snapshots to service_role;
grant usage, select on sequence public.product_price_event_snapshots_id_seq to service_role;

-- Política global de precio financiado (Admin → Financiación). Lo existente
-- queda en el comportamiento habitual: cubrir costos de Mercado Pago.
insert into public.site_settings (key, value, description)
values (
  'financed_price_policy',
  '{"policy": "cover_costs"}'::jsonb,
  'Política de precio financiado: cubrir costos de Mercado Pago o mismo precio que contado.'
)
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────────
-- Cambio programado de precios
-- ─────────────────────────────────────────────────────────────

create or replace function public.apply_scheduled_price_event(
  p_event_id uuid,
  p_updates jsonb,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.product_bulk_events%rowtype;
  v_update jsonb;
  v_product public.productos%rowtype;
  v_after_price numeric;
  v_count integer := 0;
  v_temporary boolean;
begin
  select * into v_event from public.product_bulk_events where id = p_event_id for update;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if v_event.event_type <> 'price_change' then
    raise exception 'EVENT_TYPE_MISMATCH';
  end if;
  -- Idempotencia: sólo un evento programado se aplica (una sola vez).
  if v_event.status <> 'scheduled' then
    return jsonb_build_object('status', 'skipped', 'eventStatus', v_event.status);
  end if;
  if v_event.starts_at is null or v_event.starts_at > p_now then
    raise exception 'EVENT_NOT_DUE';
  end if;
  if jsonb_typeof(p_updates) <> 'array' or jsonb_array_length(p_updates) = 0 then
    raise exception 'EVENT_WITHOUT_PRODUCTS';
  end if;

  v_temporary := v_event.ends_at is not null;

  for v_update in select value from jsonb_array_elements(p_updates) loop
    select * into v_product
    from public.productos
    where id = (v_update ->> 'product_id')::bigint
    for update;
    if not found then
      raise exception 'PRODUCT_NOT_FOUND';
    end if;

    -- El cálculo se hizo sobre estos valores: si cambiaron, no se escribe nada.
    if v_product.precio is distinct from (v_update -> 'before' ->> 'precio')::numeric
      or v_product.precio_anterior is distinct from (v_update -> 'before' ->> 'precio_anterior')::numeric
      or v_product.descuento is distinct from (v_update -> 'before' ->> 'descuento')::integer then
      raise exception 'PRICE_EVENT_STALE';
    end if;

    if v_product.promo_event_id is not null and v_product.promo_event_id <> p_event_id then
      raise exception 'PRODUCT_LOCKED_BY_EVENT';
    end if;

    v_after_price := (v_update -> 'after' ->> 'precio')::numeric;
    if v_after_price is null or v_after_price < 1 or v_after_price > 99999999.99 then
      raise exception 'INVALID_PRICE';
    end if;

    insert into public.product_price_event_snapshots (
      event_id, product_id, product_name, action_kind, value,
      precio_before, precio_anterior_before, descuento_before,
      precio_after, precio_anterior_after, descuento_after, applied_at
    ) values (
      p_event_id, v_product.id, v_product.nombre, v_event.action_kind, v_event.value,
      v_product.precio, v_product.precio_anterior, v_product.descuento,
      v_after_price,
      (v_update -> 'after' ->> 'precio_anterior')::numeric,
      (v_update -> 'after' ->> 'descuento')::integer,
      p_now
    );

    update public.productos set
      precio = v_after_price,
      precio_anterior = (v_update -> 'after' ->> 'precio_anterior')::numeric,
      descuento = (v_update -> 'after' ->> 'descuento')::integer,
      -- Temporal: el producto queda tomado por el evento hasta restaurarlo.
      promo_event_id = case when v_temporary then p_event_id else promo_event_id end
    where id = v_product.id;

    v_count := v_count + 1;
  end loop;

  update public.product_bulk_events set
    -- Permanente: se ejecuta una vez y queda aplicado (no hay reversión).
    status = case when v_temporary then 'active' else 'finished' end,
    executed_at = p_now,
    activated_at = p_now,
    failed_phase = null,
    last_error = null,
    result = jsonb_build_object('affected', v_count),
    updated_at = p_now
  where id = p_event_id;

  return jsonb_build_object('status', 'applied', 'affected', v_count, 'temporary', v_temporary);
end;
$$;

create or replace function public.restore_scheduled_price_event(
  p_event_id uuid,
  p_now timestamptz,
  p_final_status text default 'finished'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.product_bulk_events%rowtype;
  v_snapshot public.product_price_event_snapshots%rowtype;
  v_product public.productos%rowtype;
  v_restored integer := 0;
  v_kept integer := 0;
  v_missing integer := 0;
begin
  if p_final_status not in ('finished', 'cancelled') then
    raise exception 'INVALID_FINAL_STATUS';
  end if;

  select * into v_event from public.product_bulk_events where id = p_event_id for update;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if v_event.event_type <> 'price_change' then
    raise exception 'EVENT_TYPE_MISMATCH';
  end if;
  -- Idempotencia: sólo un evento activo se restaura (una sola vez).
  if v_event.status <> 'active' then
    return jsonb_build_object('status', 'skipped', 'eventStatus', v_event.status);
  end if;

  for v_snapshot in
    select * from public.product_price_event_snapshots
    where event_id = p_event_id and restored_at is null
    order by product_id
    for update
  loop
    select * into v_product from public.productos where id = v_snapshot.product_id for update;

    if not found then
      update public.product_price_event_snapshots
      set restored_at = p_now, restore_result = 'product_missing'
      where id = v_snapshot.id;
      v_missing := v_missing + 1;
    elsif v_product.precio = v_snapshot.precio_after
      and v_product.precio_anterior is not distinct from v_snapshot.precio_anterior_after
      and v_product.descuento is not distinct from v_snapshot.descuento_after then
      -- Sigue con lo que puso el evento: vuelve a los valores EXACTOS previos.
      update public.productos set
        precio = v_snapshot.precio_before,
        precio_anterior = v_snapshot.precio_anterior_before,
        descuento = v_snapshot.descuento_before,
        promo_event_id = case when promo_event_id = p_event_id then null else promo_event_id end
      where id = v_product.id;
      update public.product_price_event_snapshots
      set restored_at = p_now, restore_result = 'restored'
      where id = v_snapshot.id;
      v_restored := v_restored + 1;
    else
      -- Alguien cambió el precio a mano durante el evento: se respeta ese
      -- cambio (nunca se pisa con un snapshot que ya no corresponde).
      update public.productos set promo_event_id = null
      where id = v_product.id and promo_event_id = p_event_id;
      update public.product_price_event_snapshots
      set restored_at = p_now, restore_result = 'kept_manual_change'
      where id = v_snapshot.id;
      v_kept := v_kept + 1;
    end if;
  end loop;

  update public.product_bulk_events set
    status = p_final_status,
    restored_at = p_now,
    cancelled_at = case when p_final_status = 'cancelled' then p_now else cancelled_at end,
    failed_phase = null,
    last_error = null,
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
      'restored', v_restored, 'keptManualChange', v_kept, 'missing', v_missing
    ),
    updated_at = p_now
  where id = p_event_id;

  return jsonb_build_object(
    'status', 'restored', 'restored', v_restored, 'keptManualChange', v_kept, 'missing', v_missing
  );
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Financiación promocional
-- ─────────────────────────────────────────────────────────────

create or replace function public.apply_financing_policy_event(
  p_event_id uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.product_bulk_events%rowtype;
  v_current text;
begin
  select * into v_event from public.product_bulk_events where id = p_event_id for update;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if v_event.event_type <> 'financing_policy' then
    raise exception 'EVENT_TYPE_MISMATCH';
  end if;
  if v_event.status <> 'scheduled' then
    return jsonb_build_object('status', 'skipped', 'eventStatus', v_event.status);
  end if;
  if v_event.starts_at is null or v_event.starts_at > p_now then
    raise exception 'EVENT_NOT_DUE';
  end if;
  insert into public.site_settings (key, value, description)
  values ('financed_price_policy', '{"policy": "cover_costs"}'::jsonb, '')
  on conflict (key) do nothing;

  select value ->> 'policy' into v_current
  from public.site_settings
  where key = 'financed_price_policy'
  for update;
  -- El mismo bloqueo que usa el cambio manual serializa ambos caminos.
  if exists (
    select 1 from public.product_bulk_events
    where event_type = 'financing_policy'
      and id <> p_event_id
      and (status = 'active' or (status = 'error' and failed_phase = 'restore'))
  ) then
    raise exception 'FINANCING_EVENT_ACTIVE';
  end if;
  if v_current is null or v_current not in ('cover_costs', 'same_as_cash') then
    v_current := 'cover_costs';
  end if;

  update public.site_settings set
    value = jsonb_build_object('policy', v_event.financing_policy, 'eventId', p_event_id),
    updated_at = p_now
  where key = 'financed_price_policy';

  -- Snapshot de la política anterior: es la que se restaura al terminar.
  update public.product_bulk_events set
    status = 'active',
    previous_financing_policy = v_current,
    executed_at = p_now,
    activated_at = p_now,
    failed_phase = null,
    last_error = null,
    result = jsonb_build_object('previousPolicy', v_current, 'appliedPolicy', v_event.financing_policy),
    updated_at = p_now
  where id = p_event_id;

  return jsonb_build_object('status', 'applied', 'previousPolicy', v_current, 'appliedPolicy', v_event.financing_policy);
end;
$$;

create or replace function public.restore_financing_policy_event(
  p_event_id uuid,
  p_now timestamptz,
  p_final_status text default 'finished'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.product_bulk_events%rowtype;
  v_restore text;
begin
  if p_final_status not in ('finished', 'cancelled') then
    raise exception 'INVALID_FINAL_STATUS';
  end if;

  select * into v_event from public.product_bulk_events where id = p_event_id for update;
  if not found then
    raise exception 'EVENT_NOT_FOUND';
  end if;
  if v_event.event_type <> 'financing_policy' then
    raise exception 'EVENT_TYPE_MISMATCH';
  end if;
  if v_event.status <> 'active' then
    return jsonb_build_object('status', 'skipped', 'eventStatus', v_event.status);
  end if;

  v_restore := coalesce(v_event.previous_financing_policy, 'cover_costs');

  insert into public.site_settings (key, value, description)
  values ('financed_price_policy', '{"policy": "cover_costs"}'::jsonb, '')
  on conflict (key) do nothing;

  perform 1 from public.site_settings where key = 'financed_price_policy' for update;
  if (select value ->> 'eventId' from public.site_settings where key = 'financed_price_policy') is distinct from p_event_id::text then
    raise exception 'FINANCING_POLICY_STALE';
  end if;

  update public.site_settings set
    value = jsonb_build_object('policy', v_restore),
    updated_at = p_now
  where key = 'financed_price_policy';

  update public.product_bulk_events set
    status = p_final_status,
    restored_at = p_now,
    cancelled_at = case when p_final_status = 'cancelled' then p_now else cancelled_at end,
    failed_phase = null,
    last_error = null,
    result = coalesce(result, '{}'::jsonb) || jsonb_build_object('restoredPolicy', v_restore),
    updated_at = p_now
  where id = p_event_id;

  return jsonb_build_object('status', 'restored', 'restoredPolicy', v_restore);
end;
$$;

-- Sólo el servidor (service_role): nunca anon/authenticated.
revoke execute on function public.apply_scheduled_price_event(uuid, jsonb, timestamptz) from public, anon, authenticated;
revoke execute on function public.restore_scheduled_price_event(uuid, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.apply_financing_policy_event(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.restore_financing_policy_event(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.apply_scheduled_price_event(uuid, jsonb, timestamptz) to service_role;
grant execute on function public.restore_scheduled_price_event(uuid, timestamptz, text) to service_role;
grant execute on function public.apply_financing_policy_event(uuid, timestamptz) to service_role;
grant execute on function public.restore_financing_policy_event(uuid, timestamptz, text) to service_role;

-- Cambio manual atómico: el mismo bloqueo de site_settings que toma el
-- evento evita que un PATCH en carrera pise una política promocional.
create or replace function public.set_financed_price_policy(
  p_policy text,
  p_actor uuid,
  p_now timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current jsonb;
begin
  if p_policy not in ('cover_costs', 'same_as_cash') then
    raise exception 'INVALID_FINANCING_POLICY';
  end if;
  insert into public.site_settings (key, value, description)
  values ('financed_price_policy', '{"policy": "cover_costs"}'::jsonb, '')
  on conflict (key) do nothing;
  select value into v_current from public.site_settings
  where key = 'financed_price_policy' for update;
  if exists (
    select 1 from public.product_bulk_events
    where event_type = 'financing_policy'
      and (status = 'active' or (status = 'error' and failed_phase = 'restore'))
  ) then
    raise exception 'FINANCING_POLICY_CONTROLLED_BY_EVENT';
  end if;
  update public.site_settings set
    value = jsonb_build_object('policy', p_policy),
    updated_by = p_actor,
    updated_at = p_now
  where key = 'financed_price_policy';
  return jsonb_build_object('previousPolicy', coalesce(v_current ->> 'policy', 'cover_costs'), 'policy', p_policy);
end;
$$;

revoke execute on function public.set_financed_price_policy(text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.set_financed_price_policy(text, uuid, timestamptz) to service_role;
