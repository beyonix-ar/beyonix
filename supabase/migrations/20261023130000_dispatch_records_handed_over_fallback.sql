-- Tabla única de Despachos: igual que 20261022110000 más un respaldo para que
-- ningún pedido entregado al transporte desaparezca. Un pedido con
-- andreani_handed_over_at que (por un error) perdió su pertenencia activa a un
-- Bulto vuelve a verse como fila individual en estado E (Entregado al
-- transporte), con la fecha y el responsable de la entrega. La agrupación
-- normal no cambia: con pertenencia activa sólo cuenta dentro de su Bulto.
begin;

create or replace function public.search_dispatch_records(
  p_page integer default 1, p_date date default null, p_order text default null,
  p_batch text default null, p_actor_id uuid default null, p_state text default null,
  p_open_all_dates boolean default false
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_order text := nullif(btrim(coalesce(p_order, '')), '');
  v_batch text := nullif(btrim(coalesce(p_batch, '')), '');
  v_batch_number text := ltrim(regexp_replace(coalesce(p_batch, ''), '[^0-9]', '', 'g'), '0');
  v_result jsonb;
begin
  if p_page < 1 or p_page > 100000 or (p_state is not null and p_state not in ('P','C','E','X'))
     or length(coalesce(p_order, '')) > 80 or length(coalesce(p_batch, '')) > 80 then
    raise exception 'DISPATCH_FILTER_INVALID';
  end if;

  with order_base as (
    select o.id, o.total, o.created_at, o.cancelled_at, o.andreani_created_at,
      o.andreani_handed_over_at, o.andreani_handed_over_by,
      pkg.id package_id, pkg.attempt_number, pkg.prepared_at, pkg.prepared_by, pkg.identified_by,
      pkg.identification_method,
      case
        when o.cancelled_at is not null then 'X'
        when o.andreani_handed_over_at is not null then 'E'
        when pkg.status = 'prepared' and o.andreani_creation_status = 'created'
          and nullif(btrim(o.andreani_tracking), '') is not null
          and nullif(btrim(o.andreani_envio_id), '') is not null then 'C'
        else 'P'
      end state
    from public.ordenes o
    left join public.order_packages pkg on pkg.order_id = o.id
    where lower(coalesce(o.shipping_provider, o.envio_proveedor, '')) = 'andreani'
      and not exists (select 1 from public.dispatch_batch_items m where m.order_id = o.id and m.removed_at is null)
      and ((o.andreani_handed_over_at is null
            and ((o.cancelled_at is null and o.financial_status = 'payment_confirmed'
                  and o.estado not in ('cancelado','enviado','en_camino','entregado'))
              or (o.cancelled_at is not null and pkg.id is not null)))
        -- Respaldo: entregado al transporte por un Bulto (andreani_handed_over_batch_id
        -- obligatorio) pero sin pertenencia activa. Normalmente nunca ocurre: con la
        -- pertenencia vigente sólo cuenta dentro de su Bulto.
        or o.andreani_handed_over_at is not null)
      and v_batch is null
      and (v_order is null or ('BX-' || (o.id + 1000)::text) ilike '%' || v_order || '%')
  ), order_rows as (
    select 'order'::text kind, b.id, null::text code, null::integer display_number, b.state,
      case b.state
        when 'X' then b.cancelled_at
        when 'E' then b.andreani_handed_over_at
        when 'C' then coalesce(b.prepared_at, b.andreani_created_at, b.created_at)
        else b.created_at
      end at,
      case b.state
        when 'X' then (select h.resolved_by from public.order_cancellation_holds h
          where h.order_id = b.id order by h.detected_at desc limit 1)
        when 'E' then b.andreani_handed_over_by
        when 'C' then coalesce(b.identified_by, b.prepared_by)
        else (select s.scanned_by from public.order_preparation_scans s
          where s.package_id = b.package_id and s.attempt_number = b.attempt_number
          order by s.scanned_at desc, s.id desc limit 1)
      end actor_id,
      (select coalesce(sum(oi.cantidad), 0) from public.orden_items oi where oi.orden_id = b.id)::integer units,
      b.total, 1 order_count,
      (b.state = 'C' and b.identification_method is not null
        and not exists (select 1 from public.dispatch_blocks k where k.order_id = b.id and k.resolved_at is null)
        and not exists (select 1 from public.order_cancellation_holds h where h.order_id = b.id and h.resolved_at is null)) selectable
    from order_base b
  ), batch_base as (
    select bt.id, bt.code, bt.display_number, bt.status, bt.created_at, bt.closed_at, bt.handed_over_at,
      bt.created_by, bt.closed_by, bt.handed_over_by, t.order_count, t.units, t.total
    from public.dispatch_batches bt
    cross join lateral (
      -- Un pedido tiene a lo sumo una pertenencia activa: sumar sólo las activas no duplica.
      select count(*)::integer order_count,
        coalesce(sum(u.units), 0)::integer units,
        coalesce(sum(o.total), 0) total
      from public.dispatch_batch_items m
      join public.ordenes o on o.id = m.order_id
      cross join lateral (select coalesce(sum(oi.cantidad), 0) units from public.orden_items oi where oi.orden_id = m.order_id) u
      where m.batch_id = bt.id and m.removed_at is null
    ) t
    where t.order_count > 0
      and (v_batch is null or bt.code ilike '%' || v_batch || '%'
        or ('Bulto - ' || lpad(coalesce(bt.display_number, bt.id)::text, 4, '0')) ilike '%' || v_batch || '%'
        or ('Bulto-' || lpad(coalesce(bt.display_number, bt.id)::text, 4, '0')) ilike '%' || v_batch || '%'
        or (v_batch_number <> '' and coalesce(bt.display_number, bt.id)::text = v_batch_number))
      and (v_order is null or exists (select 1 from public.dispatch_batch_items m
        where m.batch_id = bt.id and m.removed_at is null
          and ('BX-' || (m.order_id + 1000)::text) ilike '%' || v_order || '%'))
  ), batch_rows as (
    select 'batch'::text kind, b.id, b.code, b.display_number, s.state,
      case s.state when 'E' then b.handed_over_at
        when 'C' then coalesce(b.closed_at, b.created_at) else b.created_at end at,
      case s.state when 'E' then b.handed_over_by
        when 'C' then coalesce(b.closed_by, b.created_by) else b.created_by end actor_id,
      b.units, b.total, b.order_count, false selectable
    from batch_base b
    cross join lateral (select case when b.status = 'handed_over' then 'E'
      when b.status = 'closed' then 'C' else 'P' end state) s
  ), filtered as materialized (
    select * from (select * from order_rows union all select * from batch_rows) r
    where (p_state is null or r.state = p_state)
      and (p_actor_id is null or r.actor_id = p_actor_id)
      and (p_date is null or (p_open_all_dates and r.state in ('P','C'))
        or (r.at >= (p_date::timestamp at time zone 'America/Argentina/Buenos_Aires')
          and r.at < ((p_date + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires')))
  ), page_rows as (
    select * from filtered order by at desc nulls last, kind, id desc limit 20 offset (p_page - 1) * 20
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'id', id, 'code', code,
      'displayNumber', display_number, 'state', state, 'at', at, 'actorId', actor_id, 'units', units,
      'total', total, 'orderCount', order_count, 'selectable', selectable)
      order by at desc nulls last, kind, id desc) from page_rows), '[]'::jsonb),
    'total', (select count(*) from filtered)) into v_result;
  return v_result;
end $$;

revoke all on function public.search_dispatch_records(integer, date, text, text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.search_dispatch_records(integer, date, text, text, uuid, text, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
