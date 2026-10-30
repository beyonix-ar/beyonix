-- Antiabuso de reservas de stock (Paso 3).
--
-- Falta (strike): una sesión de reserva de un usuario autenticado que, al
-- reservarse, sumó 15 o más unidades Y dejó al menos un producto/variante/
-- unidad con descuento con disponible 0 (medido en ese momento, guardado en
-- reservation_abuse_candidates), y que terminó sin compra confirmada: la
-- ventana venció sin pedido, o su pedido se canceló sin pago.
-- 2 faltas -> 7 días sin poder crear reservas nuevas. Al vencer el bloqueo
-- automático el contador vuelve a 0. Una compra confirmada
-- (inventory_order_consumes_stock, cualquier medio) vuelve el contador a 0.
-- Los bloqueos manuales (7 días / permanente) y por IP sólo los maneja Admin
-- y no los toca ni la compra ni el vencimiento del bloqueo automático.
--
-- La evaluación es perezosa y no agrega cron: corre al intentar reservar y
-- al consultar Admin. Idempotente: una falta por sesión (índice único) y
-- todo bajo pg_advisory_xact_lock(93002, usuario).
--
-- Acceso: reserve_cart_stock pasa a ser sólo de service_role. El navegador
-- llega por el server action de BEYONIX, que valida el JWT (usuario real) y
-- toma la IP confiable (X-Real-IP del proxy); ambos entran como parámetros y
-- el gate de usuario + IP corre dentro de la misma función, sin paso previo
-- que una llamada REST directa pueda omitir.
begin;

create table public.reservation_abuse_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  strike_count integer not null default 0 check (strike_count >= 0),
  last_strike_at timestamptz,
  auto_blocked_at timestamptz,
  auto_blocked_until timestamptz,
  manual_block text check (manual_block in ('temporary', 'permanent')),
  manual_blocked_at timestamptz,
  manual_blocked_until timestamptz,
  manual_blocked_by uuid,
  manual_reason text check (manual_reason is null or length(manual_reason) <= 300),
  updated_at timestamptz not null default now(),
  constraint reservation_abuse_states_auto_window check ((auto_blocked_at is null) = (auto_blocked_until is null)),
  constraint reservation_abuse_states_manual_window check (
    (manual_block is null and manual_blocked_until is null)
    or (manual_block = 'temporary' and manual_blocked_until is not null)
    or (manual_block = 'permanent' and manual_blocked_until is null)
  )
);

-- Foto de la sesión al reservar (no se recalcula después: el stock cambia).
create table public.reservation_abuse_candidates (
  session_id text primary key references public.checkout_reservation_sessions(session_id),
  user_id uuid not null references auth.users(id) on delete cascade,
  reserved_units integer not null check (reserved_units > 0),
  items jsonb not null,
  emptied_items jsonb not null,
  client_ip inet,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  evaluated_at timestamptz,
  outcome text check (outcome in ('strike', 'purchased', 'forgiven_by_purchase')),
  constraint reservation_abuse_candidates_outcome check ((evaluated_at is null) = (outcome is null))
);
create index reservation_abuse_candidates_pending_idx
  on public.reservation_abuse_candidates (user_id, created_at) where evaluated_at is null;

create table public.reservation_abuse_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  event_type text not null check (event_type in (
    'RESERVATION_ABUSE_STRIKE', 'AUTO_BLOCK_STARTED', 'AUTO_BLOCK_EXPIRED',
    'MANUAL_BLOCK', 'MANUAL_BLOCK_EXPIRED', 'PERMANENT_BLOCK', 'MANUAL_UNBLOCK',
    'STRIKES_RESET_AFTER_PURCHASE', 'IP_BLOCKED', 'IP_UNBLOCKED'
  )),
  session_id text,
  order_id bigint,
  client_ip inet,
  actor_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index reservation_abuse_events_one_strike_per_session
  on public.reservation_abuse_events (session_id) where event_type = 'RESERVATION_ABUSE_STRIKE';
create index reservation_abuse_events_user_idx on public.reservation_abuse_events (user_id, created_at desc);
create index reservation_abuse_events_ip_idx on public.reservation_abuse_events (client_ip) where client_ip is not null;

create table public.reservation_ip_blocks (
  ip inet primary key,
  reason text check (reason is null or length(reason) <= 300),
  blocked_by uuid,
  blocked_at timestamptz not null default now()
);

-- Última IP confiable (X-Real-IP del proxy) de la sesión, registrada por
-- reserve_cart_stock. Sólo service_role la informa: el navegador nunca.
create table public.checkout_reservation_client_ips (
  session_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_ip inet not null,
  seen_at timestamptz not null default now()
);

alter table public.reservation_abuse_states enable row level security;
alter table public.reservation_abuse_candidates enable row level security;
alter table public.reservation_abuse_events enable row level security;
alter table public.reservation_ip_blocks enable row level security;
alter table public.checkout_reservation_client_ips enable row level security;
revoke all on public.reservation_abuse_states, public.reservation_abuse_candidates,
  public.reservation_abuse_events, public.reservation_ip_blocks,
  public.checkout_reservation_client_ips from public, anon, authenticated;
grant select on public.reservation_abuse_states, public.reservation_abuse_candidates,
  public.reservation_abuse_events, public.reservation_ip_blocks,
  public.checkout_reservation_client_ips to service_role;

-- Fin automático de bloqueos vencidos. El automático reinicia el ciclo.
create or replace function public.reservation_abuse_normalize(p_user_id uuid, p_now timestamptz)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_until timestamptz;
  v_strikes integer;
begin
  select auto_blocked_until, strike_count into v_until, v_strikes
  from public.reservation_abuse_states
  where user_id = p_user_id and auto_blocked_until <= p_now;
  if found then
    update public.reservation_abuse_states
    set strike_count = 0, auto_blocked_at = null, auto_blocked_until = null, updated_at = p_now
    where user_id = p_user_id;
    insert into public.reservation_abuse_events (user_id, event_type, details)
    values (p_user_id, 'AUTO_BLOCK_EXPIRED',
            jsonb_build_object('blocked_until', v_until, 'strikes_before_reset', v_strikes));
  end if;

  select manual_blocked_until into v_until
  from public.reservation_abuse_states
  where user_id = p_user_id and manual_block = 'temporary' and manual_blocked_until <= p_now;
  if found then
    update public.reservation_abuse_states
    set manual_block = null, manual_blocked_at = null, manual_blocked_until = null,
        manual_blocked_by = null, manual_reason = null, updated_at = p_now
    where user_id = p_user_id;
    insert into public.reservation_abuse_events (user_id, event_type, details)
    values (p_user_id, 'MANUAL_BLOCK_EXPIRED', jsonb_build_object('blocked_until', v_until));
  end if;
end;
$$;

create or replace function public.reservation_abuse_add_strike(
  p_user_id uuid, p_session_id text, p_reason text, p_now timestamptz
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_candidate public.reservation_abuse_candidates%rowtype;
  v_event_id bigint;
  v_state public.reservation_abuse_states%rowtype;
begin
  select * into v_candidate from public.reservation_abuse_candidates
  where session_id = p_session_id and user_id = p_user_id;
  if not found then return; end if;

  insert into public.reservation_abuse_events
    (user_id, event_type, session_id, order_id, client_ip, details)
  select p_user_id, 'RESERVATION_ABUSE_STRIKE', p_session_id, s.order_id, v_candidate.client_ip,
         jsonb_build_object('reason', p_reason, 'reserved_units', v_candidate.reserved_units,
                            'emptied_items', v_candidate.emptied_items, 'items', v_candidate.items)
  from public.checkout_reservation_sessions s where s.session_id = p_session_id
  on conflict (session_id) where event_type = 'RESERVATION_ABUSE_STRIKE' do nothing
  returning id into v_event_id;

  update public.reservation_abuse_candidates
  set evaluated_at = p_now, outcome = 'strike', updated_at = p_now
  where session_id = p_session_id and evaluated_at is null;
  -- La misma sesión nunca suma dos veces.
  if v_event_id is null then return; end if;

  insert into public.reservation_abuse_states (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  update public.reservation_abuse_states
  set strike_count = strike_count + 1, last_strike_at = p_now, updated_at = p_now
  where user_id = p_user_id
  returning * into v_state;

  if v_state.strike_count >= 2
     and (v_state.auto_blocked_until is null or v_state.auto_blocked_until <= p_now) then
    update public.reservation_abuse_states
    set auto_blocked_at = p_now, auto_blocked_until = p_now + interval '7 days', updated_at = p_now
    where user_id = p_user_id;
    insert into public.reservation_abuse_events (user_id, event_type, session_id, client_ip, details)
    values (p_user_id, 'AUTO_BLOCK_STARTED', p_session_id, v_candidate.client_ip,
            jsonb_build_object('strikes', v_state.strike_count,
                               'blocked_until', p_now + interval '7 days'));
  end if;
end;
$$;

-- Resuelve las sesiones candidatas ya terminadas de un usuario.
create or replace function public.reservation_abuse_evaluate_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_now timestamptz;
  v_candidate record;
begin
  if p_user_id is null then return; end if;
  perform pg_advisory_xact_lock(93002, hashtext(p_user_id::text));
  v_now := clock_timestamp();
  perform public.reservation_abuse_normalize(p_user_id, v_now);

  for v_candidate in
    select c.session_id, s.expires_at, s.order_id, o.estado, o.payment_status
    from public.reservation_abuse_candidates c
    join public.checkout_reservation_sessions s on s.session_id = c.session_id
    left join public.ordenes o on o.id = s.order_id
    where c.user_id = p_user_id and c.evaluated_at is null
    order by c.created_at, c.session_id
  loop
    if v_candidate.order_id is not null
       and public.inventory_order_consumes_stock(v_candidate.estado, v_candidate.payment_status) then
      update public.reservation_abuse_candidates
      set evaluated_at = v_now, outcome = 'purchased', updated_at = v_now
      where session_id = v_candidate.session_id and evaluated_at is null;
    elsif v_candidate.order_id is null and v_candidate.expires_at <= v_now then
      perform public.reservation_abuse_add_strike(p_user_id, v_candidate.session_id, 'expired', v_now);
    elsif v_candidate.order_id is not null and v_candidate.estado = 'cancelado' then
      perform public.reservation_abuse_add_strike(p_user_id, v_candidate.session_id, 'cancelled', v_now);
    end if;
    -- Sesión vigente o pedido todavía pendiente: se decide más adelante.
  end loop;
end;
$$;

create or replace function public.reservation_abuse_block_reason(
  p_user_id uuid, p_client_ip inet, p_now timestamptz
)
returns text language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select case
              when manual_block = 'permanent' then 'permanent'
              when manual_block = 'temporary' and manual_blocked_until > p_now then 'manual'
              when auto_blocked_until > p_now then 'auto'
            end
     from public.reservation_abuse_states where user_id = p_user_id),
    (select 'ip' from public.reservation_ip_blocks
     where p_client_ip is not null and ip = p_client_ip)
  );
$$;

-- La IP de esta llamada manda; sin IP en la llamada se usa la última que el
-- servidor registró para la sesión de ese usuario (nunca una inventada).
create or replace function public.reservation_abuse_gate(p_user_id uuid, p_session_id text, p_client_ip inet)
returns text language plpgsql security definer set search_path = public
as $$
declare
  v_ip inet := p_client_ip;
begin
  perform public.reservation_abuse_evaluate_user(p_user_id);
  if v_ip is null then
    select client_ip into v_ip from public.checkout_reservation_client_ips
    where session_id = p_session_id and user_id = p_user_id;
  end if;
  return public.reservation_abuse_block_reason(p_user_id, v_ip, clock_timestamp());
end;
$$;

-- Foto al reservar: 15+ unidades en la sesión y algún renglón con
-- disponible 0 DESPUÉS de aplicarla (sin excluir esta sesión). Una vez
-- candidata, sigue siéndolo aunque la sesión después reserve menos.
create or replace function public.reservation_abuse_record_candidate(p_session_id text, p_user_id uuid)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_units integer;
  v_items jsonb;
  v_emptied jsonb;
begin
  if p_user_id is null then return; end if;
  select coalesce(sum(quantity), 0)::integer into v_units
  from public.stock_reservations where session_id = p_session_id and order_id is null;
  if v_units < 15 then return; end if;

  with lines as (
    select product_id, variant_id, conditioned_stock_id, sum(quantity)::integer quantity
    from public.stock_reservations where session_id = p_session_id and order_id is null
    group by 1, 2, 3
  ), measured as (
    select lines.*, public.available_stock_for_session(
             product_id, variant_id, conditioned_stock_id, null) as available_after
    from lines
  )
  select jsonb_agg(jsonb_build_object('product_id', product_id, 'variant_id', variant_id,
                                      'conditioned_stock_id', conditioned_stock_id,
                                      'quantity', quantity) order by product_id, variant_id),
         jsonb_agg(jsonb_build_object('product_id', product_id, 'variant_id', variant_id,
                                      'conditioned_stock_id', conditioned_stock_id,
                                      'quantity', quantity) order by product_id, variant_id)
           filter (where available_after <= 0)
  into v_items, v_emptied
  from measured;
  if v_emptied is null then return; end if;

  insert into public.reservation_abuse_candidates
    (session_id, user_id, reserved_units, items, emptied_items, client_ip)
  values (p_session_id, p_user_id, v_units, v_items, v_emptied,
          (select client_ip from public.checkout_reservation_client_ips
           where session_id = p_session_id and user_id = p_user_id))
  on conflict (session_id) do update
  set reserved_units = excluded.reserved_units, items = excluded.items,
      emptied_items = excluded.emptied_items,
      client_ip = coalesce(excluded.client_ip, reservation_abuse_candidates.client_ip),
      updated_at = now()
  where reservation_abuse_candidates.evaluated_at is null
    and reservation_abuse_candidates.user_id = excluded.user_id;
end;
$$;

-- Compra confirmada por cualquier medio (MP, transferencia, saldo, Admin):
-- mismo criterio que el inventario. Contador a 0 y las candidatas abiertas
-- de esa cuenta dejan de poder sumar faltas.
create or replace function public.reservation_abuse_reset_after_purchase()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_now timestamptz;
  v_previous integer;
begin
  if new.usuario_id is null
     or not public.inventory_order_consumes_stock(new.estado, new.payment_status) then
    return new;
  end if;
  if tg_op = 'UPDATE' and public.inventory_order_consumes_stock(old.estado, old.payment_status) then
    return new;
  end if;

  perform pg_advisory_xact_lock(93002, hashtext(new.usuario_id::text));
  v_now := clock_timestamp();
  update public.reservation_abuse_candidates c
  set evaluated_at = v_now, updated_at = v_now,
      outcome = case when s.order_id = new.id then 'purchased' else 'forgiven_by_purchase' end
  from public.checkout_reservation_sessions s
  where s.session_id = c.session_id and c.user_id = new.usuario_id and c.evaluated_at is null;

  select strike_count into v_previous from public.reservation_abuse_states
  where user_id = new.usuario_id and strike_count > 0
  for update;
  if found then
    update public.reservation_abuse_states
    set strike_count = 0, updated_at = v_now where user_id = new.usuario_id;
    insert into public.reservation_abuse_events (user_id, event_type, order_id, details)
    values (new.usuario_id, 'STRIKES_RESET_AFTER_PURCHASE', new.id,
            jsonb_build_object('previous_strikes', v_previous));
  end if;
  return new;
end;
$$;

create trigger reservation_abuse_reset_after_purchase
after insert or update of estado, payment_status on public.ordenes
for each row execute function public.reservation_abuse_reset_after_purchase();

-- La firma anterior (text, jsonb) tomaba el usuario de auth.uid() y tenía
-- EXECUTE para anon/authenticated: una llamada REST directa reservaba sin
-- pasar por el servidor ni por el bloqueo por IP. Se reemplaza por una
-- versión sólo service_role con usuario e IP provistos por el servidor.
drop function public.reserve_cart_stock(text, jsonb);

create function public.reserve_cart_stock(
  p_session_id text, p_items jsonb, p_user_id uuid, p_client_ip inet
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_session public.checkout_reservation_sessions%rowtype;
  v_item record;
  v_variant record;
  v_product_id bigint;
  v_available integer;
  v_count integer;
  v_now timestamptz;
  v_remaining integer;
  v_take integer;
  v_block text;
begin
  -- Defensa adicional al GRANT: sólo el servidor (service_role) informa
  -- usuario e IP.
  if auth.role() is distinct from 'service_role' then raise exception 'INVALID_SESSION'; end if;
  if p_session_id is null or length(btrim(p_session_id)) < 8
     or length(p_session_id) > 160 then
    raise exception 'INVALID_SESSION';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_QUANTITY';
  end if;

  perform pg_advisory_xact_lock(93001, hashtext(p_session_id));
  v_now := clock_timestamp();
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id;

  if found then
    if v_session.order_id is not null then raise exception 'RESERVATION_LOCKED_TO_ORDER'; end if;
    if v_session.user_id is not null and v_session.user_id is distinct from p_user_id then
      raise exception 'INVALID_SESSION';
    end if;
    if v_session.expires_at <= v_now then raise exception 'RESERVATION_EXPIRED'; end if;
  elsif jsonb_array_length(p_items) = 0 then
    raise exception 'INVALID_SESSION';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'quantity', '') !~ '^[1-9][0-9]{0,2}$'
  ) then raise exception 'INVALID_QUANTITY'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) item
    where coalesce(item ->> 'productId', item ->> 'product_id', '') !~ '^[0-9]{1,18}$'
       or (coalesce(item ->> 'variantId', item ->> 'variant_id') is not null
           and coalesce(item ->> 'variantId', item ->> 'variant_id') !~ '^[0-9]{1,18}$')
       or (coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id') is not null
           and coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')
               !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then raise exception 'INVALID_VARIANT'; end if;

  select count(*) into v_count from (
    select 1 from jsonb_array_elements(p_items) item
    group by coalesce(item ->> 'productId', item ->> 'product_id'),
             coalesce(item ->> 'variantId', item ->> 'variant_id'),
             coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')
    having sum((item ->> 'quantity')::integer) > 999
  ) excessive;
  if v_count > 0 then raise exception 'INVALID_QUANTITY'; end if;

  for v_product_id in
    select distinct product_id from (
      select coalesce(item ->> 'productId', item ->> 'product_id')::bigint as product_id
      from jsonb_array_elements(p_items) item
      union
      select product_id from public.stock_reservations where session_id = p_session_id
    ) targets order by 1
  loop
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;

  -- Antiabuso: una reserva nueva exige cuenta y que ni la cuenta ni la IP
  -- confiable de esta llamada estén bloqueadas. Se evalúa DESPUÉS de los
  -- locks de producto (mismo orden que los pagos: producto -> usuario) y
  -- ANTES de tocar una sola fila de stock. Bloqueado se devuelve sin
  -- excepción para conservar las faltas recién evaluadas.
  if jsonb_array_length(p_items) > 0 then
    if p_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
    if p_client_ip is not null then
      insert into public.checkout_reservation_client_ips (session_id, user_id, client_ip)
      values (p_session_id, p_user_id, p_client_ip)
      on conflict (session_id) do update
      set client_ip = excluded.client_ip, seen_at = now()
      where checkout_reservation_client_ips.user_id = excluded.user_id;
    end if;
    v_block := public.reservation_abuse_gate(p_user_id, p_session_id, p_client_ip);
    if v_block is not null then
      return jsonb_build_object('reserved', false, 'blocked', true);
    end if;
  end if;

  v_now := clock_timestamp();
  select * into v_session from public.checkout_reservation_sessions
  where session_id = p_session_id;
  if found and v_session.order_id is not null then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;
  if found and v_session.expires_at <= v_now then
    raise exception 'RESERVATION_EXPIRED';
  end if;
  if exists (select 1 from public.stock_reservations
             where session_id = p_session_id and order_id is not null) then
    raise exception 'RESERVATION_LOCKED_TO_ORDER';
  end if;

  if not exists (select 1 from public.checkout_reservation_sessions where session_id = p_session_id) then
    insert into public.checkout_reservation_sessions
      (session_id, user_id, reservation_started_at, expires_at)
    values (p_session_id, p_user_id, v_now, v_now + public.checkout_step_reservation_ttl())
    returning * into v_session;
  elsif v_session.user_id is null and p_user_id is not null then
    update public.checkout_reservation_sessions set user_id = p_user_id
    where session_id = p_session_id;
  end if;

  delete from public.stock_reservations where session_id = p_session_id;
  for v_item in
    select coalesce(item ->> 'productId', item ->> 'product_id')::bigint as product_id,
           coalesce(item ->> 'variantId', item ->> 'variant_id')::bigint as variant_id,
           coalesce(item ->> 'conditionedStockId', item ->> 'conditioned_stock_id')::uuid as conditioned_stock_id,
           sum((item ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) item
    group by 1, 2, 3 order by 1, 2 nulls first, 3 nulls first
  loop
    if v_item.product_id <= 0 or v_item.variant_id <= 0
       or (v_item.variant_id is not null and v_item.conditioned_stock_id is not null)
       or not exists (select 1 from public.productos
                      where id = v_item.product_id and activo) then
      raise exception 'INVALID_VARIANT';
    end if;

    if v_item.variant_id is null and v_item.conditioned_stock_id is null
       and exists (select 1 from public.producto_variantes
                   where producto_id = v_item.product_id and activo) then
      if not exists (select 1 from public.productos
                     where id = v_item.product_id and venta_aleatoria) then
        raise exception 'INVALID_VARIANT';
      end if;
      -- Venta aleatoria: unidades reales del pool, nunca un color inexistente.
      v_remaining := v_item.quantity;
      for v_variant in
        select variants.id,
               public.available_stock_for_session(v_item.product_id, variants.id, null, p_session_id)
                 - coalesce((select sum(own.quantity) from public.stock_reservations own
                             where own.session_id = p_session_id and own.product_id = v_item.product_id
                               and own.variant_id = variants.id), 0) as available
        from public.producto_variantes variants
        where variants.producto_id = v_item.product_id and variants.activo
        order by 2 desc, variants.id
      loop
        exit when v_remaining = 0;
        v_take := least(v_remaining, greatest(v_variant.available, 0));
        continue when v_take = 0;
        if exists (select 1 from public.stock_reservations
                   where session_id = p_session_id and product_id = v_item.product_id
                     and variant_id = v_variant.id and conditioned_stock_id is null) then
          update public.stock_reservations set quantity = quantity + v_take
          where session_id = p_session_id and product_id = v_item.product_id
            and variant_id = v_variant.id and conditioned_stock_id is null;
        else
          insert into public.stock_reservations
            (session_id, user_id, product_id, variant_id, conditioned_stock_id, quantity, expires_at)
          values (p_session_id, coalesce(v_session.user_id, p_user_id),
                  v_item.product_id, v_variant.id, null, v_take, v_session.expires_at);
        end if;
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0 then raise exception 'OUT_OF_STOCK'; end if;
      continue;
    end if;

    v_available := public.available_stock_for_session(
      v_item.product_id, v_item.variant_id, v_item.conditioned_stock_id, p_session_id
    );
    if v_available is null then raise exception 'INVALID_VARIANT'; end if;
    if v_available < v_item.quantity then raise exception 'OUT_OF_STOCK'; end if;
    insert into public.stock_reservations
      (session_id, user_id, product_id, variant_id, conditioned_stock_id,
       quantity, expires_at)
    values (p_session_id, coalesce(v_session.user_id, p_user_id),
            v_item.product_id, v_item.variant_id, v_item.conditioned_stock_id,
            v_item.quantity, v_session.expires_at);
  end loop;

  if jsonb_array_length(p_items) > 0 then
    perform public.reservation_abuse_record_candidate(p_session_id, p_user_id);
  end if;

  return jsonb_build_object('reserved', jsonb_array_length(p_items) > 0,
                            'reservation_started_at', v_session.reservation_started_at,
                            'expires_at', v_session.expires_at);
end;
$$;

-- Admin (service_role): resuelve las candidatas ya terminadas de todos.
create or replace function public.evaluate_reservation_abuse()
returns integer language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'INVALID_SESSION'; end if;
  for v_user in
    select user_id from public.reservation_abuse_candidates where evaluated_at is null
    union
    select user_id from public.reservation_abuse_states
    where auto_blocked_until <= clock_timestamp()
       or (manual_block = 'temporary' and manual_blocked_until <= clock_timestamp())
  loop
    perform public.reservation_abuse_evaluate_user(v_user);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.admin_set_reservation_block(
  p_user_id uuid, p_action text, p_admin_id uuid, p_reason text default null
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_now timestamptz;
  v_state public.reservation_abuse_states%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.role() <> 'service_role' then raise exception 'INVALID_SESSION'; end if;
  if p_user_id is null or p_admin_id is null then raise exception 'INVALID_USER'; end if;
  if p_action not in ('block_7_days', 'block_permanent', 'unblock') then
    raise exception 'INVALID_ACTION';
  end if;
  perform public.reservation_abuse_evaluate_user(p_user_id);
  v_now := clock_timestamp();
  insert into public.reservation_abuse_states (user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into v_state from public.reservation_abuse_states where user_id = p_user_id for update;

  if p_action = 'unblock' then
    update public.reservation_abuse_states
    set strike_count = 0, auto_blocked_at = null, auto_blocked_until = null,
        manual_block = null, manual_blocked_at = null, manual_blocked_until = null,
        manual_blocked_by = null, manual_reason = null, updated_at = v_now
    where user_id = p_user_id;
    insert into public.reservation_abuse_events (user_id, event_type, actor_id, details)
    values (p_user_id, 'MANUAL_UNBLOCK', p_admin_id, jsonb_build_object(
      'reason', v_reason, 'previous_manual_block', v_state.manual_block,
      'previous_auto_blocked_until', v_state.auto_blocked_until,
      'previous_strikes', v_state.strike_count));
    return;
  end if;

  update public.reservation_abuse_states
  set manual_block = case when p_action = 'block_permanent' then 'permanent' else 'temporary' end,
      manual_blocked_at = v_now,
      manual_blocked_until = case when p_action = 'block_permanent' then null else v_now + interval '7 days' end,
      manual_blocked_by = p_admin_id,
      manual_reason = left(v_reason, 300),
      updated_at = v_now
  where user_id = p_user_id;
  insert into public.reservation_abuse_events (user_id, event_type, actor_id, details)
  values (p_user_id,
          case when p_action = 'block_permanent' then 'PERMANENT_BLOCK' else 'MANUAL_BLOCK' end,
          p_admin_id,
          jsonb_build_object('reason', v_reason, 'blocked_until',
            case when p_action = 'block_permanent' then null else v_now + interval '7 days' end));
end;
$$;

create or replace function public.admin_set_reservation_ip_block(
  p_client_ip inet, p_blocked boolean, p_admin_id uuid, p_reason text default null
)
returns void language plpgsql security definer set search_path = public
as $$
declare
  v_reason text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
begin
  if auth.role() <> 'service_role' then raise exception 'INVALID_SESSION'; end if;
  if p_client_ip is null or p_admin_id is null then raise exception 'INVALID_IP'; end if;
  if p_blocked then
    insert into public.reservation_ip_blocks (ip, reason, blocked_by)
    values (p_client_ip, v_reason, p_admin_id)
    on conflict (ip) do update set reason = excluded.reason, blocked_by = excluded.blocked_by,
      blocked_at = now();
    insert into public.reservation_abuse_events (event_type, client_ip, actor_id, details)
    values ('IP_BLOCKED', p_client_ip, p_admin_id, jsonb_build_object('reason', v_reason));
  else
    delete from public.reservation_ip_blocks where ip = p_client_ip;
    if found then
      insert into public.reservation_abuse_events (event_type, client_ip, actor_id, details)
      values ('IP_UNBLOCKED', p_client_ip, p_admin_id, jsonb_build_object('reason', v_reason));
    end if;
  end if;
end;
$$;

revoke all on function public.reservation_abuse_normalize(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reservation_abuse_add_strike(uuid, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reservation_abuse_evaluate_user(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reservation_abuse_block_reason(uuid, inet, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.reservation_abuse_gate(uuid, text, inet) from public, anon, authenticated, service_role;
revoke all on function public.reservation_abuse_record_candidate(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reservation_abuse_reset_after_purchase() from public, anon, authenticated, service_role;
-- Reserva: sólo el servidor. anon/authenticated no pueden llamarla por REST.
revoke all on function public.reserve_cart_stock(text, jsonb, uuid, inet) from public, anon, authenticated;
grant execute on function public.reserve_cart_stock(text, jsonb, uuid, inet) to service_role;
revoke all on function public.evaluate_reservation_abuse() from public, anon, authenticated;
grant execute on function public.evaluate_reservation_abuse() to service_role;
revoke all on function public.admin_set_reservation_block(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_reservation_block(uuid, text, uuid, text) to service_role;
revoke all on function public.admin_set_reservation_ip_block(inet, boolean, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_reservation_ip_block(inet, boolean, uuid, text) to service_role;

commit;
