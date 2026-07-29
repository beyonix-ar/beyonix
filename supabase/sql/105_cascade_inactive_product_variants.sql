create or replace function public.deactivate_product_variants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.activo is distinct from new.activo then
    update public.producto_variantes
    set activo = new.activo
    where producto_id = new.id
      and activo is distinct from new.activo;
  end if;

  return new;
end;
$$;

drop trigger if exists deactivate_product_variants_trigger
  on public.productos;

create trigger deactivate_product_variants_trigger
after update of activo on public.productos
for each row
execute function public.deactivate_product_variants();

comment on function public.deactivate_product_variants() is
  'Aplica a todas las variantes el estado elegido en el producto principal.';

create or replace function public.prevent_active_variant_on_inactive_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.activo = true
    and exists (
      select 1
      from public.productos
      where id = new.producto_id
        and activo = false
    )
  then
    new.activo := false;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_active_variant_on_inactive_product_trigger
  on public.producto_variantes;

create trigger prevent_active_variant_on_inactive_product_trigger
before insert or update of activo, producto_id on public.producto_variantes
for each row
execute function public.prevent_active_variant_on_inactive_product();

update public.producto_variantes as variante
set activo = false
from public.productos as producto
where producto.id = variante.producto_id
  and producto.activo = false
  and variante.activo is distinct from false;

comment on function public.prevent_active_variant_on_inactive_product() is
  'Impide activar una variante mientras su producto principal esté inactivo.';
