create or replace function public.prevent_return_inventory_reprocessing()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.return_inventory_processed_at is not null and (
    new.return_restocked_quantity is distinct from old.return_restocked_quantity
    or new.return_written_off_quantity is distinct from old.return_written_off_quantity
    or new.return_inventory_note is distinct from old.return_inventory_note
    or new.return_inventory_processed_at is distinct from old.return_inventory_processed_at
    or new.return_inventory_processed_by is distinct from old.return_inventory_processed_by
  ) then
    raise exception 'La recepción de este producto ya fue registrada y no puede modificarse.';
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_return_inventory_reprocessing
  on public.orden_items;

create trigger prevent_return_inventory_reprocessing
before update on public.orden_items
for each row
execute function public.prevent_return_inventory_reprocessing();
