alter table public.reviews
  add column if not exists city text,
  add column if not exists province text;

update public.reviews
set
  city = coalesce(nullif(trim(city), ''), 'Ciudad no informada'),
  province = coalesce(nullif(trim(province), ''), 'Provincia no informada');

alter table public.reviews
  alter column city set not null,
  alter column province set not null,
  drop column if exists product_id,
  drop column if exists product_name;