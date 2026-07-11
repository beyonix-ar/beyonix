alter table public.orden_items
  add column if not exists warranty_started_at timestamptz,
  add column if not exists warranty_expires_at timestamptz,
  add column if not exists warranty_months integer not null default 6,
  add column if not exists warranty_status text not null default 'pending_delivery';

alter table public.orden_items
  drop constraint if exists orden_items_warranty_months_check,
  add constraint orden_items_warranty_months_check
    check (warranty_months >= 0 and warranty_months <= 120);

alter table public.orden_items
  drop constraint if exists orden_items_warranty_status_check,
  add constraint orden_items_warranty_status_check
    check (warranty_status in ('pending_delivery', 'active', 'expired', 'voided'));

create index if not exists orden_items_warranty_status_idx
  on public.orden_items (warranty_status);

create index if not exists orden_items_warranty_expires_at_idx
  on public.orden_items (warranty_expires_at);

comment on column public.orden_items.warranty_started_at is
  'Uso interno administrativo. Inicio de garantía para la línea de producto vendida.';

comment on column public.orden_items.warranty_expires_at is
  'Uso interno administrativo. Vencimiento de garantía calculado por meses calendario.';

comment on column public.orden_items.warranty_months is
  'Uso interno administrativo. Meses de garantía aplicados a la línea de producto vendida.';

comment on column public.orden_items.warranty_status is
  'Uso interno administrativo. Estado base de garantía; la vigencia final debe comparar warranty_expires_at con la fecha actual.';

comment on table public.orden_items is
  'Cada fila representa una línea de producto comprada. Si cantidad es mayor a 1, la garantía se controla por línea, no por unidad individual.';

revoke select on public.orden_items from anon, authenticated;

grant select (
  id,
  orden_id,
  producto_id,
  variante_id,
  cantidad,
  precio,
  precio_unitario
) on public.orden_items to authenticated;

revoke update (
  warranty_started_at,
  warranty_expires_at,
  warranty_months,
  warranty_status
) on public.orden_items from anon, authenticated;
