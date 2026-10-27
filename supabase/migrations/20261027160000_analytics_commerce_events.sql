-- Analítica comercial (1/3): eventos de comportamiento add_to_cart, search y
-- checkout_started en analytics_events.
--
-- Fuente de cada evento (todas server-side vía service_role; el navegador sólo
-- avisa y nunca aporta usuario, resultados ni precios):
--   * add_to_cart: el carrito es estado local del navegador (no hay acción de
--     servidor al agregar), así que llega como beacon. Cada acción real que
--     suma UNA unidad al carrito es un evento (no hay deduplicación comercial);
--     la idempotencia técnica (doble request, reintento) la da client_event_id
--     único. Producto activo y variante del producto se validan acá.
--   * search: búsqueda ejecutada (Enter, botón o sugerencia). La consulta llega
--     normalizada y filtrada de datos sensibles por el servidor; la cantidad de
--     resultados la calcula esta función con la misma regla del catálogo público
--     (productos activos cuyo nombre contiene el texto, sin distinguir
--     mayúsculas), nunca el cliente.
--   * checkout_started: entrada real al checkout con carrito válido. Uno por
--     sesión de Analítica (índice único): recargar, reintentar u otra pestaña de
--     la misma sesión no suman.
-- purchase_completed NO es un evento del navegador: ver 20261027170000.
--
-- record_product_view se redefine sólo para que su límite por origen cuente
-- product_view (con los nuevos eventos, el mismo client_key no debe consumir
-- el cupo de vistas). Misma política en todo lo demás.

begin;

-- 1. Columnas tipadas (sin JSON libre) ----------------------------------------

alter table public.analytics_events
  add column if not exists client_event_id uuid,
  add column if not exists search_query text,
  add column if not exists search_results integer;

comment on column public.analytics_events.client_event_id is
  'Id aleatorio de la acción en el navegador: idempotencia técnica (doble request, reintento). No identifica a nadie.';
comment on column public.analytics_events.search_query is
  'Búsqueda normalizada (minúsculas, espacios simples, hasta 80 caracteres), sin datos sensibles.';
comment on column public.analytics_events.search_results is
  'Productos activos que coincidían con la búsqueda al ejecutarla (calculado server-side).';

alter table public.analytics_events drop constraint if exists analytics_events_event_type_check;
alter table public.analytics_events add constraint analytics_events_event_type_check
  check (event_type in ('product_view', 'add_to_cart', 'search', 'checkout_started'));

-- Producto: obligatorio en vistas y carrito; nunca en búsqueda ni checkout.
alter table public.analytics_events drop constraint if exists analytics_events_product_view_product_check;
alter table public.analytics_events add constraint analytics_events_product_check
  check (
    case event_type
      when 'product_view' then product_id is not null
      when 'add_to_cart' then product_id is not null
      else product_id is null and variant_id is null
    end
  );

alter table public.analytics_events add constraint analytics_events_search_check
  check (
    case event_type
      when 'search' then search_query is not null
        and char_length(search_query) between 1 and 80
        and search_query = lower(search_query)
        and search_results is not null and search_results >= 0
      else search_query is null and search_results is null
    end
  );

-- Idempotencia técnica de las acciones del navegador.
create unique index if not exists analytics_events_client_event_id_key
  on public.analytics_events (client_event_id)
  where client_event_id is not null;

-- Un checkout_started por sesión.
create unique index if not exists analytics_events_checkout_session_key
  on public.analytics_events (session_id)
  where event_type = 'checkout_started';

-- Sesión + tipo: límites por sesión de los nuevos eventos y funnel por sesión.
create index if not exists analytics_events_session_type_occurred_idx
  on public.analytics_events (session_id, event_type, occurred_at desc)
  where event_type <> 'product_view';

-- Ranking de búsquedas del período.
create index if not exists analytics_events_search_occurred_idx
  on public.analytics_events (occurred_at desc, search_query)
  where event_type = 'search';

comment on table public.analytics_events is
  'Eventos de comportamiento de la tienda (product_view, add_to_cart, search, checkout_started). Acceso exclusivo server-side vía RPC. Las compras confirmadas viven en analytics_purchases.';

-- 2. Snapshot de producto (mismo criterio que record_product_view) ------------

create or replace function public.analytics_touch_product_snapshot(p_product public.productos)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.analytics_product_snapshots as s (product_id, product_name, product_slug, product_image, updated_at)
  values (
    p_product.id,
    p_product.nombre,
    p_product.slug,
    public.analytics_product_image(p_product.id, p_product.imagen_principal),
    now()
  )
  on conflict (product_id) do update
    set product_name = excluded.product_name,
        product_slug = excluded.product_slug,
        product_image = excluded.product_image,
        updated_at = excluded.updated_at
    where (s.product_name, s.product_slug, s.product_image)
      is distinct from (excluded.product_name, excluded.product_slug, excluded.product_image);
$$;

revoke all on function public.analytics_touch_product_snapshot(public.productos) from public, anon, authenticated;

-- 3. product_view: el límite por origen cuenta sólo vistas --------------------

create or replace function public.record_product_view(
  p_session_id uuid,
  p_product_id bigint,
  p_user_id uuid default null,
  p_source text default null,
  p_device_type text default null,
  p_client_key text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dedup_window constant interval := interval '30 minutes';
  v_rate_window constant interval := interval '1 hour';
  v_max_per_session constant integer := 120;
  v_max_per_client constant integer := 600;
  v_product public.productos%rowtype;
begin
  if p_session_id is null or p_product_id is null or p_product_id <= 0 then
    return 'invalid';
  end if;

  select * into v_product from public.productos where id = p_product_id and activo is true;
  if not found then
    return 'invalid_product';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('analytics:product_view:' || p_session_id::text || ':' || p_product_id::text, 0)
  );

  if exists (
    select 1
    from public.analytics_events
    where event_type = 'product_view'
      and session_id = p_session_id
      and product_id = p_product_id
      and occurred_at > now() - v_dedup_window
  ) then
    return 'duplicate';
  end if;

  if (
    select count(*)
    from public.analytics_events
    where event_type = 'product_view'
      and session_id = p_session_id
      and occurred_at > now() - v_rate_window
  ) >= v_max_per_session then
    return 'rate_limited';
  end if;

  if p_client_key is not null and (
    select count(*)
    from public.analytics_events
    where client_key = p_client_key
      and event_type = 'product_view'
      and occurred_at > now() - v_rate_window
  ) >= v_max_per_client then
    return 'rate_limited';
  end if;

  insert into public.analytics_events (
    event_type, session_id, user_id, product_id, source, device_type, client_key
  ) values (
    'product_view', p_session_id, p_user_id, p_product_id, p_source, p_device_type, p_client_key
  );

  perform public.analytics_touch_product_snapshot(v_product);

  return 'recorded';
end;
$$;

-- 4. Límite por ventana móvil de una hora, por tipo de evento ------------------

create or replace function public.analytics_event_rate_exceeded(
  p_event_type text,
  p_session_id uuid,
  p_client_key text,
  p_max_per_session integer,
  p_max_per_client integer
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (
      select count(*)
      from public.analytics_events
      where event_type = p_event_type
        and session_id = p_session_id
        and occurred_at > now() - interval '1 hour'
    ) >= p_max_per_session
    or (
      p_client_key is not null and (
        select count(*)
        from public.analytics_events
        where client_key = p_client_key
          and event_type = p_event_type
          and occurred_at > now() - interval '1 hour'
      ) >= p_max_per_client
    );
$$;

revoke all on function public.analytics_event_rate_exceeded(text, uuid, text, integer, integer) from public, anon, authenticated;

-- 5. add_to_cart ----------------------------------------------------------------

-- 'recorded' | 'duplicate' (mismo client_event_id) | 'invalid' |
-- 'invalid_product' (inexistente/inactivo o variante ajena) | 'rate_limited'.
create or replace function public.record_add_to_cart(
  p_session_id uuid,
  p_client_event_id uuid,
  p_product_id bigint,
  p_variant_id bigint default null,
  p_user_id uuid default null,
  p_device_type text default null,
  p_client_key text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.productos%rowtype;
  v_inserted integer;
begin
  if p_session_id is null or p_client_event_id is null or p_product_id is null or p_product_id <= 0
    or (p_variant_id is not null and p_variant_id <= 0) then
    return 'invalid';
  end if;

  select * into v_product from public.productos where id = p_product_id and activo is true;
  if not found then
    return 'invalid_product';
  end if;

  if p_variant_id is not null and not exists (
    select 1 from public.producto_variantes where id = p_variant_id and producto_id = p_product_id
  ) then
    return 'invalid_product';
  end if;

  if exists (select 1 from public.analytics_events where client_event_id = p_client_event_id) then
    return 'duplicate';
  end if;

  -- 60 unidades por hora y sesión (el carrito admite pocas por producto) y
  -- 300 por origen: mucho más que una compra real, poco para inflar el funnel.
  if public.analytics_event_rate_exceeded('add_to_cart', p_session_id, p_client_key, 60, 300) then
    return 'rate_limited';
  end if;

  insert into public.analytics_events (
    event_type, session_id, user_id, product_id, variant_id, device_type, client_key, client_event_id
  ) values (
    'add_to_cart', p_session_id, p_user_id, p_product_id, p_variant_id, p_device_type, p_client_key, p_client_event_id
  )
  on conflict (client_event_id) where client_event_id is not null do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return 'duplicate';
  end if;

  perform public.analytics_touch_product_snapshot(v_product);
  return 'recorded';
end;
$$;

-- 6. search -----------------------------------------------------------------------

-- 'recorded' | 'duplicate' | 'invalid' | 'rate_limited'.
create or replace function public.record_search(
  p_session_id uuid,
  p_client_event_id uuid,
  p_query text,
  p_user_id uuid default null,
  p_device_type text default null,
  p_client_key text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_results integer;
  v_inserted integer;
begin
  if p_session_id is null or p_client_event_id is null or p_query is null
    or char_length(p_query) not between 1 and 80 or p_query <> lower(p_query) then
    return 'invalid';
  end if;

  if exists (select 1 from public.analytics_events where client_event_id = p_client_event_id) then
    return 'duplicate';
  end if;

  -- Buscar es más frecuente que agregar al carrito: 60 por hora y sesión, 600 por origen.
  if public.analytics_event_rate_exceeded('search', p_session_id, p_client_key, 60, 600) then
    return 'rate_limited';
  end if;

  -- Misma regla que el catálogo público (lib/products/catalog-filters.ts).
  select count(*)::integer into v_results
  from public.productos
  where activo is true
    and strpos(lower(nombre), p_query) > 0;

  insert into public.analytics_events (
    event_type, session_id, user_id, device_type, client_key, client_event_id, search_query, search_results
  ) values (
    'search', p_session_id, p_user_id, p_device_type, p_client_key, p_client_event_id, p_query, v_results
  )
  on conflict (client_event_id) where client_event_id is not null do nothing;
  get diagnostics v_inserted = row_count;
  return case when v_inserted = 0 then 'duplicate' else 'recorded' end;
end;
$$;

-- 7. checkout_started -----------------------------------------------------------

-- 'recorded' | 'duplicate' (la sesión ya inició un checkout) | 'invalid'.
create or replace function public.record_checkout_started(
  p_session_id uuid,
  p_user_id uuid default null,
  p_device_type text default null,
  p_client_key text default null
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_session_id is null then
    return 'invalid';
  end if;

  insert into public.analytics_events (event_type, session_id, user_id, device_type, client_key)
  values ('checkout_started', p_session_id, p_user_id, p_device_type, p_client_key)
  on conflict (session_id) where event_type = 'checkout_started' do nothing;
  get diagnostics v_inserted = row_count;
  return case when v_inserted = 0 then 'duplicate' else 'recorded' end;
end;
$$;

revoke all on function public.record_add_to_cart(uuid, uuid, bigint, bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_search(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_checkout_started(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_add_to_cart(uuid, uuid, bigint, bigint, uuid, text, text) to service_role;
grant execute on function public.record_search(uuid, uuid, text, uuid, text, text) to service_role;
grant execute on function public.record_checkout_started(uuid, uuid, text, text) to service_role;

commit;
