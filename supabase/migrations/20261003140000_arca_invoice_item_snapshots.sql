-- Conserva el detalle que se usará para regenerar Facturas C sin depender del catálogo.
-- Las facturas anteriores se capturan con los datos que aún existen al aplicar
-- esta migración; un nombre cambiado o eliminado antes no puede recuperarse.
begin;

create table public.arca_invoice_header_snapshots (
  order_id bigint primary key references public.ordenes(id) on delete restrict,
  fiscal_total numeric(12, 2) not null check (fiscal_total > 0),
  captured_at timestamptz not null default clock_timestamp()
);

create table public.arca_invoice_item_snapshots (
  order_id bigint not null references public.ordenes(id) on delete restrict,
  order_item_id bigint not null,
  quantity numeric not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  product_name text not null check (btrim(product_name) <> ''),
  variant_name text,
  captured_at timestamptz not null default clock_timestamp(),
  primary key (order_id, order_item_id)
);

alter table public.arca_invoice_header_snapshots enable row level security;
alter table public.arca_invoice_item_snapshots enable row level security;
revoke all on public.arca_invoice_header_snapshots from public, anon, authenticated;
revoke all on public.arca_invoice_item_snapshots from public, anon, authenticated;
grant select on public.arca_invoice_header_snapshots to service_role;
grant select on public.arca_invoice_item_snapshots to service_role;

create function public.capture_arca_invoice_items()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if new.invoice_requested_number is null or new.invoice_cae is not null
     or old.invoice_requested_number is not distinct from new.invoice_requested_number then
    return new;
  end if;

  insert into public.arca_invoice_header_snapshots (order_id, fiscal_total)
  values (new.id, coalesce(new.invoice_requested_total, new.total))
  on conflict (order_id) do update
    set fiscal_total = excluded.fiscal_total, captured_at = clock_timestamp();

  insert into public.arca_invoice_item_snapshots
    (order_id, order_item_id, quantity, unit_price, product_name, variant_name)
  select i.orden_id, i.id, i.cantidad, i.precio,
    coalesce(nullif(btrim(p.nombre), ''), 'Producto #' || i.producto_id::text, 'Producto eliminado'),
    coalesce(nullif(btrim(i.conditioned_name), ''), nullif(btrim(v.nombre), ''))
  from public.orden_items i
  left join public.productos p on p.id = i.producto_id
  left join public.producto_variantes v on v.id = i.variante_id
  where i.orden_id = new.id
  on conflict (order_id, order_item_id) do update
    set quantity = excluded.quantity,
        unit_price = excluded.unit_price,
        product_name = excluded.product_name,
        variant_name = excluded.variant_name,
        captured_at = clock_timestamp();
  return new;
end;
$$;

revoke all on function public.capture_arca_invoice_items() from public, anon, authenticated;
create trigger capture_arca_invoice_items_on_request
  after update of invoice_requested_number on public.ordenes
  for each row execute function public.capture_arca_invoice_items();

-- Backfill de comprobantes ya autorizados y solicitudes inciertas en curso.
-- Los comprobantes anteriores sin total reservado congelan el único importe
-- disponible hoy en una tabla separada. No modifica ninguna factura existente.
insert into public.arca_invoice_header_snapshots (order_id, fiscal_total)
select id, coalesce(invoice_requested_total, total)
from public.ordenes
where (invoice_cae is not null or invoice_requested_number is not null)
  and coalesce(invoice_requested_total, total) > 0
on conflict (order_id) do nothing;

insert into public.arca_invoice_item_snapshots
  (order_id, order_item_id, quantity, unit_price, product_name, variant_name)
select i.orden_id, i.id, i.cantidad, i.precio,
  coalesce(nullif(btrim(p.nombre), ''), 'Producto #' || i.producto_id::text, 'Producto eliminado'),
  coalesce(nullif(btrim(i.conditioned_name), ''), nullif(btrim(v.nombre), ''))
from public.orden_items i
join public.ordenes o on o.id = i.orden_id
left join public.productos p on p.id = i.producto_id
left join public.producto_variantes v on v.id = i.variante_id
where o.invoice_cae is not null or o.invoice_requested_number is not null
on conflict (order_id, order_item_id) do nothing;

commit;
