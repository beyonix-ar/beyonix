-- Estado comercial de las unidades devueltas que se ofrecen con descuento.

alter table public.inventory_return_movements
  add column if not exists conditioned_active boolean not null default false;

alter table public.inventory_return_movements
  drop constraint if exists inventory_return_movements_conditioned_active_check,
  add constraint inventory_return_movements_conditioned_active_check check (
    discounted_quantity > 0 or conditioned_active = false
  );

create or replace function public.normalize_conditioned_stock_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.discounted_quantity <= 0 then
    new.conditioned_active := false;
  end if;
  return new;
end;
$$;

drop trigger if exists normalize_conditioned_stock_state
  on public.inventory_return_movements;
create trigger normalize_conditioned_stock_state
before insert or update on public.inventory_return_movements
for each row execute function public.normalize_conditioned_stock_state();

comment on column public.inventory_return_movements.conditioned_active is
  'Indica si la unidad con descuento está habilitada para su gestión comercial.';
