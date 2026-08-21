-- product_variant_activation_error() exigía una fila en
-- inventory_variant_allocations para considerar que la variante "tiene
-- stock asignado", pero eso ignora el caso (ya soportado desde Compras)
-- donde el stock llega directo con la compra ya tagueada a esa variante
-- (product_cost_entries.variant_id), sin pasar nunca por el mecanismo de
-- asignación manual. En ese caso producto_variantes.stock ya refleja el
-- stock real, pero la activación seguía bloqueada pidiendo "asignar" algo
-- que ya estaba correctamente asignado.
--
-- Fix: usar el stock real de la variante (que ya contempla asignación
-- manual + movimientos tagueados directamente), no solo la tabla de
-- asignación manual.

create or replace function public.product_variant_activation_error(
  p_product_id bigint,
  p_variant_id bigint,
  p_primary boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_subject text := case
    when p_primary then 'La variante principal'
    else 'La variante'
  end;
begin
  select * into v_variant
  from public.producto_variantes variants
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id;

  if not found then
    return case
      when p_primary then 'Creá al menos una variante.'
      else 'La variante ya no existe.'
    end;
  end if;
  if nullif(btrim(coalesce(v_variant.nombre, '')), '') is null then
    return v_subject || ' necesita un nombre.';
  end if;
  if nullif(btrim(coalesce(v_variant.sku, '')), '') is null then
    return v_subject || ' necesita un SKU.';
  end if;
  if v_variant.color_hex is null
     or v_variant.color_hex !~ '^#[0-9A-Fa-f]{6}$' then
    return v_subject || ' necesita un color.';
  end if;
  if jsonb_typeof(coalesce(v_variant.imagenes, '[]'::jsonb)) <> 'array' then
    return v_subject || ' necesita al menos una imagen.';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements_text(v_variant.imagenes) images(url)
    where nullif(btrim(images.url), '') is not null
  ) then
    return v_subject || ' necesita al menos una imagen.';
  end if;

  if coalesce(v_variant.stock, 0) <= 0 then
    return v_subject || ' necesita stock asignado.';
  end if;

  return null;
end;
$$;
