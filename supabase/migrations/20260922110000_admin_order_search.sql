begin;
create or replace function public.search_admin_orders(p_search text, p_limit integer default 50, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_result jsonb; v_term text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Acceso denegado'; end if;
  if p_search is null or length(btrim(p_search)) < 1 or length(p_search) > 160 then raise exception 'Búsqueda inválida'; end if;
  v_term := '%' || replace(replace(replace(lower(btrim(p_search)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  with matching as materialized (
    select o.id, o.admin_visible_at from public.ordenes o
    where o.admin_visible_at is not null and (
      concat_ws(' ', o.id::text, 'BX-' || (o.id + 1000)::text, 'BX' || (o.id + 1000)::text,
        to_jsonb(o)->>'cliente_nombre', to_jsonb(o)->>'cliente_email', to_jsonb(o)->>'cliente_telefono',
        to_jsonb(o)->>'cliente_username', to_jsonb(o)->>'tracking_number', to_jsonb(o)->>'andreani_tracking',
        to_jsonb(o)->>'invoice_cae', to_jsonb(o)->>'invoice_number', to_jsonb(o)->>'invoice_point',
        to_jsonb(o)->>'payment_id', to_jsonb(o)->>'mercadopago_payment_id', to_jsonb(o)->>'transfer_matched_payment_id',
        to_jsonb(o)->>'external_reference', to_jsonb(o)->>'mercadopago_preference_id',
        concat_ws('-', lpad(to_jsonb(o)->>'invoice_point',4,'0'),lpad(to_jsonb(o)->>'invoice_number',8,'0'))) ilike v_term escape '\'
      or exists (
        select 1 from public.orden_items i
        left join public.productos p on p.id = i.producto_id
        left join public.producto_variantes v on v.id = i.variante_id
        where i.orden_id = o.id and concat_ws(' ', to_jsonb(p)->>'nombre', to_jsonb(p)->>'sku',
          to_jsonb(v)->>'nombre', to_jsonb(v)->>'sku', to_jsonb(i)->>'conditioned_sku',
          to_jsonb(i)->>'conditioned_name', to_jsonb(i)->>'product_name', to_jsonb(i)->>'sku') ilike v_term escape '\'
      )
    )
  ), page as (
    select id from matching order by admin_visible_at desc, id desc
    limit least(100, greatest(1, p_limit)) offset greatest(0, p_offset)
  ) select jsonb_build_object('ids', coalesce((select jsonb_agg(id) from page), '[]'::jsonb), 'total', (select count(*) from matching)) into v_result;
  return v_result;
end;
$$;
revoke all on function public.search_admin_orders(text, integer, integer) from public, anon, authenticated;
grant execute on function public.search_admin_orders(text, integer, integer) to service_role;
commit;
