-- Descripción enriquecida: respaldo en la base.
--
-- El saneado vive en un único lugar (lib/products/rich-description.ts,
-- sanitizeRichDescription) y corre server-side en las rutas de alta y edición.
-- Pero RLS permite a un Admin escribir productos.descripcion directo por REST,
-- y cualquier flujo futuro podría olvidarse de sanear. Esta guarda no sanea
-- (no duplica la allowlist): sólo VERIFICA que lo que se persiste sea la forma
-- canónica que produce el sanitizer, y rechaza cualquier otra cosa.
--
-- Forma canónica: texto con < > & " escapados y únicamente las etiquetas
-- <p> <br> <strong> <em> <u> <h2> <h3> y <span class="rt-size-sm|lg|xl">, sin
-- otros atributos. Si al quitar esas etiquetas queda un < o >, hay marcado
-- que el sanitizer nunca emite.
--
-- Se valida sólo cuando la descripción cambia: un texto legacy que no se
-- toca sigue igual (la tienda ya lo renderiza como texto, sin innerHTML).

create or replace function public.product_description_is_canonical(p_description text)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp as $$
  select p_description is null or (
    length(p_description) <= 200000
    and regexp_replace(
      p_description,
      '</?(p|br|strong|em|u|h2|h3)>|<span class="rt-size-(sm|lg|xl)">|</span>',
      '', 'g'
    ) !~ '[<>]'
  )
$$;

create or replace function public.guard_product_description()
returns trigger language plpgsql
set search_path = pg_catalog, public, pg_temp as $$
begin
  if (tg_op = 'INSERT' or new.descripcion is distinct from old.descripcion)
     and not public.product_description_is_canonical(new.descripcion) then
    raise exception 'PRODUCT_DESCRIPTION_UNSAFE'
      using errcode = '22023',
            hint = 'La descripción debe guardarse saneada (sanitizeRichDescription).';
  end if;
  return new;
end $$;

drop trigger if exists guard_product_description on public.productos;
create trigger guard_product_description
  before insert or update of descripcion on public.productos
  for each row execute function public.guard_product_description();

revoke all on function public.guard_product_description() from public, anon, authenticated;
