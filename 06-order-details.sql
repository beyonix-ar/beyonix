-- Detalles legibles de ordenes y variantes compradas.
-- Ejecutar en Supabase SQL Editor.

alter table public.ordenes
add column if not exists cliente_nombre text;

alter table public.ordenes
add column if not exists cliente_email text;

alter table public.ordenes
add column if not exists cliente_telefono text;

alter table public.ordenes
add column if not exists cliente_direccion text;

alter table public.orden_items
add column if not exists variante_id bigint;

alter table public.orden_items
add column if not exists precio numeric;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orden_items_variante_id_fkey'
  ) then
    alter table public.orden_items
    add constraint orden_items_variante_id_fkey
    foreign key (variante_id)
    references public.producto_variantes(id)
    on delete set null;
  end if;
end $$;

create index if not exists orden_items_variante_id_idx
on public.orden_items(variante_id);

create or replace view public.ordenes_detalle as
select
  o.id as orden_id,
  o.usuario_id,
  coalesce(o.cliente_nombre, p.nombre) as cliente_nombre,
  coalesce(o.cliente_email, p.email) as cliente_email,
  o.cliente_telefono,
  o.cliente_direccion,
  o.estado,
  o.total,
  o.created_at,
  timezone('America/Argentina/Buenos_Aires', o.created_at) as fecha_argentina,
  oi.id as item_id,
  oi.producto_id,
  pr.nombre as producto_nombre,
  oi.variante_id,
  pv.nombre as variante_nombre,
  pv.color_hex as variante_color_hex,
  oi.cantidad,
  oi.precio
from public.ordenes o
left join public.profiles p on p.id = o.usuario_id
left join public.orden_items oi on oi.orden_id = o.id
left join public.productos pr on pr.id = oi.producto_id
left join public.producto_variantes pv on pv.id = oi.variante_id;

grant select on public.ordenes_detalle to authenticated;

notify pgrst, 'reload schema';
