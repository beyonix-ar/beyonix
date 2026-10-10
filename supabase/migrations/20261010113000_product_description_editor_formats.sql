-- Extiende la guarda existente al formato canónico del editor de descripciones.
-- No transforma descripciones previas ni altera el trigger.
create or replace function public.product_description_is_canonical(p_description text)
returns boolean language sql immutable
set search_path = pg_catalog, public, pg_temp as $$
  select p_description is null or (
    length(p_description) <= 200000
    and regexp_replace(
      p_description,
      '</?(p|br|strong|em|u|h2|h3|ul|ol|li)>|<(p|h2|h3|ul|ol) class="rt-align-(center|right)">|<span class="rt-size-(12|14|16|18|20|22|24|28|32|36|40)">|</span>',
      '', 'g'
    ) !~ '[<>]'
  )
$$;
