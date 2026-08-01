-- Evita variantes duplicadas por nombre o color incluso bajo concurrencia.

create or replace function public.prevent_duplicate_product_variant_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(94000, new.producto_id::integer);

  if exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = new.producto_id
      and variants.id is distinct from new.id
      and lower(btrim(variants.nombre)) = lower(btrim(new.nombre))
  ) then
    raise exception
      'Ya existe una variante llamada % para este producto.',
      new.nombre;
  end if;

  if exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = new.producto_id
      and variants.id is distinct from new.id
      and upper(btrim(variants.color_hex)) = upper(btrim(new.color_hex))
  ) then
    raise exception
      'El color % ya está asignado a otra variante del producto.',
      new.color_hex;
  end if;

  return new;
end;
$$;

drop trigger if exists prevent_duplicate_product_variant_identity
  on public.producto_variantes;
create trigger prevent_duplicate_product_variant_identity
before insert or update of producto_id, nombre, color_hex
on public.producto_variantes
for each row execute function public.prevent_duplicate_product_variant_identity();

comment on function public.prevent_duplicate_product_variant_identity() is
  'Serializa cambios de variantes y bloquea nombres o colores duplicados dentro del producto.';
