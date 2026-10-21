-- Tablero de Despachos: Confirmados es una cola de trabajo.
--
-- Igual que 20261018133000, salvo:
--   * Confirmados filtra (sólo si se pide una fecha) por la preparación del
--     pedido: coalesce(prepared_at, andreani_created_at, created_at). La API ya
--     no aplica "hoy" por defecto: lo pendiente no desaparece por antigüedad.
--   * El filtro de operador incluye a quien confirmó la etiqueta Andreani
--     (order_andreani_label_confirmed, 20261021100000).
create or replace function public.search_dispatch_board(
  p_tab text, p_page integer default 1, p_search text default null,
  p_date_from date default null, p_date_to date default null,
  p_batch text default null, p_operator_ids uuid[] default null,
  p_state text default null, p_quantity_kind text default null,
  p_quantity_min integer default null, p_quantity_max integer default null,
  p_sku text default null, p_tracking text default null,
  p_has_cancelled boolean default null, p_has_removed boolean default null,
  p_invoiced boolean default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_result jsonb;
begin
  if p_tab not in ('armado','ready','open','delivered') or p_page < 1 or p_page > 100000
     or p_date_from > p_date_to or p_quantity_min < 0 or p_quantity_max < 0
     or p_quantity_min > p_quantity_max then
    raise exception 'DISPATCH_FILTER_INVALID';
  end if;
  if p_tab in ('armado','ready') then
    with filtered as materialized (
      select o.id, o.created_at, o.andreani_created_at
      from public.ordenes o
      left join public.order_packages pkg on pkg.order_id = o.id
      where o.financial_status = 'payment_confirmed'
        and o.cancelled_at is null and o.andreani_handed_over_at is null
        and o.estado not in ('cancelado','enviado','en_camino','entregado')
        and lower(coalesce(o.shipping_provider,o.envio_proveedor,'')) = 'andreani'
        and not exists (select 1 from public.dispatch_batch_items m where m.order_id = o.id and m.removed_at is null)
        and ((p_tab = 'ready' and pkg.status = 'prepared' and o.andreani_creation_status = 'created'
              and nullif(btrim(o.andreani_tracking),'') is not null and nullif(btrim(o.andreani_envio_id),'') is not null)
          or (p_tab = 'armado' and not (pkg.status = 'prepared' and o.andreani_creation_status = 'created'
              and nullif(btrim(o.andreani_tracking),'') is not null and nullif(btrim(o.andreani_envio_id),'') is not null)))
        and (p_state is null or (p_state = 'Pendiente' and p_tab = 'armado') or (p_state = 'Confirmado' and p_tab = 'ready'))
        and (p_date_from is null or (case when p_tab = 'ready' then coalesce(pkg.prepared_at,o.andreani_created_at,o.created_at) else o.created_at end)
          >= (p_date_from::timestamp at time zone 'America/Argentina/Buenos_Aires'))
        and (p_date_to is null or (case when p_tab = 'ready' then coalesce(pkg.prepared_at,o.andreani_created_at,o.created_at) else o.created_at end)
          < ((p_date_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires'))
        and (p_search is null or o.andreani_tracking ilike '%' || p_search || '%'
          or o.andreani_envio_id ilike '%' || p_search || '%'
          or ('BX-' || (o.id + 1000)::text) ilike '%' || p_search || '%'
          or exists (select 1 from public.order_preparation_lines l where l.package_id = pkg.id
            and (l.expected_sku ilike '%' || p_search || '%' or l.expected_barcode ilike '%' || p_search || '%'))
          or exists (select 1 from public.orden_items oi join public.productos pr on pr.id = oi.producto_id
            where oi.orden_id = o.id and (pr.nombre ilike '%' || p_search || '%' or pr.sku ilike '%' || p_search || '%')))
        and (p_batch is null or exists (select 1 from public.dispatch_batch_items m
          join public.dispatch_batches b on b.id = m.batch_id where m.order_id = o.id
          and (b.code ilike '%' || p_batch || '%' or ('Bulto - ' || lpad(coalesce(b.display_number,b.id)::text,4,'0')) ilike '%' || p_batch || '%'
            or b.display_number::text = ltrim(regexp_replace(p_batch,'[^0-9]','','g'),'0'))))
        and (p_operator_ids is null or pkg.prepared_by = any(p_operator_ids)
          or exists (select 1 from public.order_preparation_scans s where s.package_id = pkg.id and s.scanned_by = any(p_operator_ids))
          or exists (select 1 from public.order_audit_events e where e.order_id = o.id and e.actor_id = any(p_operator_ids) and e.action in ('dispatch_andreani_shipment_generated','order_andreani_label_printed','order_andreani_label_confirmed')))
        and (p_quantity_kind is null or p_quantity_kind = 'units')
        and (p_quantity_min is null or (select coalesce(sum(oi.cantidad),0) from public.orden_items oi where oi.orden_id = o.id) >= p_quantity_min)
        and (p_quantity_max is null or (select coalesce(sum(oi.cantidad),0) from public.orden_items oi where oi.orden_id = o.id) <= p_quantity_max)
        and (p_sku is null or exists (select 1 from public.orden_items oi join public.productos pr on pr.id = oi.producto_id
          where oi.orden_id = o.id and pr.sku ilike '%' || p_sku || '%'))
        and (p_tracking is null or o.andreani_tracking ilike '%' || p_tracking || '%')
        and (p_invoiced is null or (o.invoice_status = 'authorized') = p_invoiced)
        and (p_has_cancelled is null or p_has_cancelled = false)
        and (p_has_removed is null or exists (select 1 from public.dispatch_batch_items m where m.order_id = o.id and m.removed_at is not null) = p_has_removed)
    ), page_ids as (
      select id from filtered order by id desc limit 20 offset (p_page - 1) * 20
    )
    select jsonb_build_object('ids',coalesce((select jsonb_agg(id order by id desc) from page_ids),'[]'::jsonb),
      'total',(select count(*) from filtered)) into v_result;
  else
    with filtered as materialized (
      select b.id, coalesce(b.handed_over_at,b.closed_at,b.created_at) sort_at
      from public.dispatch_batches b
      cross join lateral (
        select count(*)::integer order_count, coalesce(sum(pkg.parcel_count),0)::integer parcel_count,
          bool_or(o.cancelled_at is not null) has_cancelled
        from public.dispatch_batch_items m
        join public.order_packages pkg on pkg.id = m.package_id
        join public.ordenes o on o.id = m.order_id
        where m.batch_id = b.id and m.removed_at is null
      ) totals
      where ((p_tab = 'open' and b.status in ('open','closed')) or (p_tab = 'delivered' and b.status = 'handed_over'))
        and totals.order_count > 0
        and (p_state is null or (p_state = 'Entregado' and b.status = 'handed_over')
          or (p_state = 'Listo para entregar' and b.status = 'closed')
          or (p_state = 'Pendiente' and b.status = 'open')
          or (p_state = 'Cancelado' and totals.has_cancelled)
          or (p_state = 'Retirado' and exists (select 1 from public.dispatch_batch_items x where x.batch_id = b.id and x.removed_at is not null)))
        and (p_date_from is null or (case when p_tab = 'delivered' then b.handed_over_at else coalesce(b.closed_at,b.created_at) end)
          >= (p_date_from::timestamp at time zone 'America/Argentina/Buenos_Aires'))
        and (p_date_to is null or (case when p_tab = 'delivered' then b.handed_over_at else coalesce(b.closed_at,b.created_at) end)
          < ((p_date_to + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires'))
        and (p_search is null or b.code ilike '%' || p_search || '%'
          or ('Bulto - ' || lpad(coalesce(b.display_number,b.id)::text,4,'0')) ilike '%' || p_search || '%'
          or exists (select 1 from public.dispatch_batch_items m join public.ordenes o on o.id = m.order_id
            where m.batch_id = b.id and (('BX-' || (o.id + 1000)::text) ilike '%' || p_search || '%'
              or o.andreani_tracking ilike '%' || p_search || '%'
              or exists (select 1 from public.order_preparation_lines l where l.package_id = m.package_id
                and (l.expected_sku ilike '%' || p_search || '%' or l.expected_barcode ilike '%' || p_search || '%'))
              or exists (select 1 from public.orden_items oi join public.productos pr on pr.id = oi.producto_id
                where oi.orden_id = o.id and (pr.nombre ilike '%' || p_search || '%' or pr.sku ilike '%' || p_search || '%')))))
        and (p_batch is null or b.code ilike '%' || p_batch || '%'
          or ('Bulto - ' || lpad(coalesce(b.display_number,b.id)::text,4,'0')) ilike '%' || p_batch || '%'
          or b.display_number::text = ltrim(regexp_replace(p_batch,'[^0-9]','','g'),'0'))
        and (p_operator_ids is null or b.created_by = any(p_operator_ids) or b.closed_by = any(p_operator_ids)
          or b.handed_over_by = any(p_operator_ids)
          or exists (select 1 from public.dispatch_batch_events e where e.batch_id = b.id and e.actor_id = any(p_operator_ids))
          or exists (select 1 from public.dispatch_batch_items m where m.batch_id = b.id
            and (m.added_by = any(p_operator_ids) or m.verified_by = any(p_operator_ids) or m.removed_by = any(p_operator_ids)))
          or exists (select 1 from public.dispatch_batch_items m join public.order_packages pkg on pkg.id = m.package_id
            where m.batch_id = b.id and pkg.prepared_by = any(p_operator_ids))
          or exists (select 1 from public.dispatch_batch_items m join public.order_preparation_scans s on s.package_id = m.package_id
            where m.batch_id = b.id and s.scanned_by = any(p_operator_ids)))
        and (p_quantity_kind is null or p_quantity_kind in ('orders','parcels'))
        and (p_quantity_min is null or (case when p_quantity_kind = 'parcels' then totals.parcel_count else totals.order_count end) >= p_quantity_min)
        and (p_quantity_max is null or (case when p_quantity_kind = 'parcels' then totals.parcel_count else totals.order_count end) <= p_quantity_max)
        and (p_sku is null or exists (select 1 from public.dispatch_batch_items m
          join public.orden_items oi on oi.orden_id = m.order_id join public.productos pr on pr.id = oi.producto_id
          where m.batch_id = b.id and pr.sku ilike '%' || p_sku || '%'))
        and (p_tracking is null or exists (select 1 from public.dispatch_batch_items m
          join public.ordenes o on o.id = m.order_id where m.batch_id = b.id and o.andreani_tracking ilike '%' || p_tracking || '%'))
        and (p_has_cancelled is null or (coalesce(totals.has_cancelled,false) or exists (select 1 from public.dispatch_batch_items m join public.ordenes o on o.id = m.order_id where m.batch_id = b.id and m.removed_at is not null and o.cancelled_at is not null)) = p_has_cancelled)
        and (p_has_removed is null or exists (select 1 from public.dispatch_batch_items m where m.batch_id = b.id and m.removed_at is not null) = p_has_removed)
        and (p_invoiced is null or exists (select 1 from public.dispatch_batch_items m join public.ordenes o on o.id = m.order_id
          where m.batch_id = b.id and m.removed_at is null and (o.invoice_status = 'authorized') = p_invoiced))
    ), page_ids as (
      select id, sort_at from filtered order by sort_at desc, id desc limit 20 offset (p_page - 1) * 20
    )
    select jsonb_build_object('ids',coalesce((select jsonb_agg(id order by sort_at desc,id desc) from page_ids),'[]'::jsonb),
      'total',(select count(*) from filtered)) into v_result;
  end if;
  return v_result;
end $$;

revoke all on function public.search_dispatch_board(text,integer,text,date,date,text,uuid[],text,text,integer,integer,text,text,boolean,boolean,boolean) from public, anon, authenticated;
grant execute on function public.search_dispatch_board(text,integer,text,date,date,text,uuid[],text,text,integer,integer,text,text,boolean,boolean,boolean) to service_role;
