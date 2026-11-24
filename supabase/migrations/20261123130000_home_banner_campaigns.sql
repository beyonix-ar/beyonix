-- Banners: campañas programadas del HOME sobre site_banner_items ------------
-- Amplía la tabla existente (no crea otra): ubicación 'home' además de
-- 'products', nombre interno, imagen opcional para celular, vigencia
-- [starts_at, ends_at) en instantes UTC (inicio inclusivo, fin exclusivo) y
-- enlace de destino opcional. El estado (Desactivada / Programada / Activa /
-- Finalizada) se calcula de active + vigencia + hora actual: no hay columna
-- de estado ni cron.
--
-- Público:
--   * La política de lectura deja de exponer filas fuera de vigencia (antes
--     bastaba active = true) y el público ya no ve columnas internas
--     (campaign_name, created_by, updated_by).
--   * get_public_site_banners(placement) es la lectura pública: filas activas
--     vigentes ordenadas por sort_order, created_at, id (Home: sólo la
--     primera), si la ubicación tiene filas propias (el respaldo heredado de
--     Productos sólo aplica cuando nunca las tuvo) y el próximo instante en
--     que cambia lo visible (sólo la hora, nunca la campaña futura).
--
-- Archivos: el bucket público site-banners admite JPEG, PNG, WebP, AVIF y
-- GIF de hasta 5 MB. GIF sólo lo usa Productos (su carrusel lo mostraba
-- antes); el Home lo rechaza en el navegador y en la API. SVG nunca: en un
-- bucket público puede ejecutar scripts. Verificado antes de restringir:
-- todos los archivos y banners existentes son PNG (máx. 1,4 MB).
--
-- Prioridad (sort_order): entero entre -999 y 999 (los existentes: 0 y 1).
--
-- Compatibilidad: las filas existentes de Productos no tienen fechas
-- (permanentes) y se siguen viendo igual. Nada se borra ni se reescribe.
--
-- Reversible: drop function public.get_public_site_banners(text); quitar las
-- columnas nuevas; restaurar el check de placement ('products') y la política
-- "Anyone can read active banner items" (active = true) y los grants previos.

begin;

alter table public.site_banner_items add column if not exists campaign_name text;
alter table public.site_banner_items add column if not exists mobile_image_url text;
alter table public.site_banner_items add column if not exists starts_at timestamptz;
alter table public.site_banner_items add column if not exists ends_at timestamptz;
alter table public.site_banner_items add column if not exists destination_url text;

alter table public.site_banner_items drop constraint if exists site_banner_items_placement_check;
alter table public.site_banner_items add constraint site_banner_items_placement_check
  check (placement in ('products', 'home'));

alter table public.site_banner_items drop constraint if exists site_banner_items_window_check;
alter table public.site_banner_items add constraint site_banner_items_window_check
  check (starts_at is null or ends_at is null or ends_at > starts_at);

alter table public.site_banner_items drop constraint if exists site_banner_items_sort_order_check;
alter table public.site_banner_items add constraint site_banner_items_sort_order_check
  check (sort_order between -999 and 999);

alter table public.site_banner_items drop constraint if exists site_banner_items_campaign_name_check;
alter table public.site_banner_items add constraint site_banner_items_campaign_name_check
  check (campaign_name is null or char_length(campaign_name) <= 120);

-- Defensa en profundidad (la API valida el destino completo): sólo rutas
-- internas o https; nunca javascript:, data: ni otros esquemas.
alter table public.site_banner_items drop constraint if exists site_banner_items_destination_url_check;
alter table public.site_banner_items add constraint site_banner_items_destination_url_check
  check (destination_url is null or (char_length(destination_url) <= 2048
    and (destination_url ~ '^/[^/\\]' or destination_url = '/' or destination_url ~* '^https://[^/\s]+')));

alter table public.site_banner_items drop constraint if exists site_banner_items_mobile_image_url_check;
alter table public.site_banner_items add constraint site_banner_items_mobile_image_url_check
  check (mobile_image_url is null or (char_length(mobile_image_url) <= 2048 and mobile_image_url ~* '^https://'));

create index if not exists site_banner_items_placement_window_idx
  on public.site_banner_items (placement, sort_order, created_at, id) where active;

-- Lectura pública directa: sólo filas activas y vigentes, sin columnas internas.
drop policy if exists "Anyone can read active banner items" on public.site_banner_items;
create policy "Anyone can read active banner items"
on public.site_banner_items
for select
to anon, authenticated
using (active = true
  and (starts_at is null or starts_at <= now())
  and (ends_at is null or ends_at > now()));

revoke select on public.site_banner_items from anon, authenticated;
grant select (id, placement, image_url, mobile_image_url, alt_text, active, sort_order,
  starts_at, ends_at, destination_url, created_at, updated_at)
  on public.site_banner_items to anon, authenticated;

create or replace function public.get_public_site_banners(p_placement text)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  with visible as (
    select b.*, row_number() over (order by b.sort_order, b.created_at, b.id) as rank
    from public.site_banner_items b
    where b.placement = p_placement and b.active
      and (b.starts_at is null or b.starts_at <= now())
      and (b.ends_at is null or b.ends_at > now())
  )
  select jsonb_build_object(
    'banners', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'placement', v.placement, 'image_url', v.image_url,
        'mobile_image_url', v.mobile_image_url, 'alt_text', v.alt_text,
        'destination_url', v.destination_url, 'active', v.active,
        'sort_order', v.sort_order, 'ends_at', v.ends_at, 'updated_at', v.updated_at)
        order by v.rank)
      from visible v
      where p_placement <> 'home' or v.rank = 1), '[]'::jsonb),
    'hasItems', exists (select 1 from public.site_banner_items b where b.placement = p_placement),
    'nextChangeAt', (select min(change_at) from (
      select v.ends_at as change_at from visible v where v.ends_at is not null
      union all
      select b.starts_at from public.site_banner_items b
      where b.placement = p_placement and b.active and b.starts_at > now()
    ) changes),
    'serverNow', now())
  where p_placement in ('products', 'home')
$$;

revoke all on function public.get_public_site_banners(text) from public;
grant execute on function public.get_public_site_banners(text) to anon, authenticated, service_role;

-- Bucket público de banners: formatos de imagen seguros y tamaño máximo.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets
      set file_size_limit = 5242880,
          allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
      where id = 'site-banners';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
