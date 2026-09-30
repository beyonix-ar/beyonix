-- Reseñas: destacado controlado por Admin, plazo de 15 días desde la entrega
-- y comentario obligatorio, garantizados también en la base.
--
-- 1. `featured`: solo las reseñas destacadas por el Admin aparecen en Home.
--    Default false: ninguna reseña existente queda destacada automáticamente.
-- 2. Plazo: una reseña NUEVA solo se acepta entre ordenes.delivered_at y
--    delivered_at + 15 días (inclusive), la misma fecha de entrega que usan
--    reclamos y garantías. timestamptz vs now(): instantes absolutos; con la
--    sesión en UTC (default de Supabase) 15 days = 360 horas exactas.
-- 3. Comentario: al menos 8 caracteres que no sean espacios en reseñas
--    NUEVAS (la pipeline completa -contenido real, moderación, datos
--    privados- vive en lib/reviews/review-text.ts y corre en la API, que es la
--    única vía de escritura).
-- 4. Escritura directa desde el navegador: se elimina la policy de INSERT de
--    clientes y se revocan INSERT/UPDATE a anon/authenticated. Todas las
--    escrituras pasan por /api/reviews y /api/admin/reviews (service_role).
--
-- Las reseñas existentes no se modifican ni se revalidan: las reglas 2 y 3
-- aplican solo a INSERT; en UPDATE solo se controla `featured`.

alter table public.reviews
  add column if not exists featured boolean not null default false,
  add column if not exists featured_at timestamptz;

create index if not exists reviews_featured_created_at_idx
  on public.reviews (created_at desc, id desc)
  where featured and approved;

create or replace function public.enforce_review_rules()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order record;
begin
  if tg_op = 'INSERT' then
    -- Una reseña nueva nunca nace destacada.
    new.featured := false;
    new.featured_at := null;

    if char_length(regexp_replace(coalesce(new.comment, ''), '\s', '', 'g')) < 8 then
      raise exception 'REVIEW_COMMENT_TOO_SHORT' using errcode = '23514';
    end if;

    select o.usuario_id, o.estado, o.delivered_at
      into v_order
      from public.ordenes o
     where o.id = new.order_id;

    if not found or v_order.usuario_id is distinct from new.user_id then
      raise exception 'REVIEW_ORDER_INVALID' using errcode = '23514';
    end if;

    if v_order.estado = 'cancelado'
       or v_order.delivered_at is null
       or now() < v_order.delivered_at then
      raise exception 'REVIEW_NOT_DELIVERED' using errcode = '23514';
    end if;

    if now() > v_order.delivered_at + interval '15 days' then
      raise exception 'REVIEW_WINDOW_EXPIRED' using errcode = '23514';
    end if;

    return new;
  end if;

  if new.featured is distinct from old.featured then
    if current_user in ('anon', 'authenticated') then
      raise exception 'REVIEW_FEATURED_FORBIDDEN' using errcode = '42501';
    end if;

    if new.featured and (not new.approved or char_length(btrim(new.comment)) = 0) then
      raise exception 'REVIEW_FEATURED_REQUIRES_COMMENT' using errcode = '23514';
    end if;

    new.featured_at := case when new.featured then now() else null end;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_review_rules() from public, anon, authenticated;

drop trigger if exists reviews_enforce_rules on public.reviews;
create trigger reviews_enforce_rules
  before insert or update on public.reviews
  for each row execute function public.enforce_review_rules();

drop policy if exists "Customers can create reviews for paid orders" on public.reviews;
revoke insert, update on table public.reviews from anon, authenticated;
