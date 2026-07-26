create or replace function public.get_admin_category_product_stats()
returns table (
  category_id bigint,
  product_count bigint,
  stock_total bigint
)
language sql
security definer
stable
set search_path = public
as $$
  select
    productos.categoria_id as category_id,
    count(*)::bigint as product_count,
    coalesce(sum(productos.stock), 0)::bigint as stock_total
  from public.productos
  where productos.categoria_id is not null
    and public.current_user_role() in ('operador', 'admin', 'super_admin')
  group by productos.categoria_id;
$$;

revoke all on function public.get_admin_category_product_stats()
  from public, anon;
grant execute on function public.get_admin_category_product_stats()
  to authenticated, service_role;

comment on function public.get_admin_category_product_stats() is
  'Devuelve totales compactos de productos y stock por categoría para el panel administrativo.';
