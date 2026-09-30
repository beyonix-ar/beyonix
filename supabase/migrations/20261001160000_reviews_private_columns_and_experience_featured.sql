-- Reseñas: privacidad de la lectura directa + destacado sólo para
-- experiencias generales.
--
-- 1. Brecha: anon y authenticated tenían SELECT sobre TODAS las columnas de
--    public.reviews (user_id, order_id, nickname = username, ...). Con la
--    policy "Public can read approved reviews" cualquiera podía leerlas
--    directo por PostgREST (/rest/v1/reviews?select=user_id,order_id,...),
--    aunque /api/reviews ya devolviera un payload seguro.
--
--    Único lector directo legítimo desde el navegador:
--    lib/reviews/product-review-summary.ts (promedio y cantidad por producto
--    del catálogo) -> product_id, rating y approved. Se suma id (ya público
--    en /api/reviews) para que el borrado propio directo que habilita la
--    policy "Customers can delete their own reviews" (WHERE id = ...) siga
--    funcionando. Todo lo demás (Home, modal, PDP, Mis compras, Admin) pasa
--    por las APIs del servidor con service_role, que conserva acceso completo.
--
--    Fail-closed: se quita el SELECT de tabla y cualquier SELECT por columna,
--    y se otorga SELECT sólo sobre esa lista explícita. Una columna nueva no
--    queda visible para anon/authenticated salvo que se otorgue a propósito.
--    La policy de lectura (approved = true) se mantiene: filas aprobadas,
--    columnas públicas.
--
--    También se quitan a anon/authenticated privilegios de tabla sin uso
--    (TRUNCATE, TRIGGER, REFERENCES) y a anon el DELETE (sólo authenticated
--    tiene policy de borrado propio; la app borra vía /api/reviews/[id]).
--
-- 2. Destacar en Home: el Home sólo muestra experiencias generales
--    (product_id null). Se agrega la regla en el trigger existente para que
--    ninguna vía (API Admin, SQL con service_role) marque featured = true en
--    una reseña de producto. Quitar el destacado sigue permitido siempre.
--
-- Sin cambios de datos: ninguna reseña existente se modifica.

-- 1. Lectura directa: sólo columnas públicas necesarias ----------------------

revoke select on table public.reviews from anon, authenticated;

do $$
declare
  v_column text;
begin
  for v_column in
    select a.attname
      from pg_attribute a
     where a.attrelid = 'public.reviews'::regclass
       and a.attnum > 0
       and not a.attisdropped
  loop
    execute format('revoke select (%I) on table public.reviews from anon, authenticated', v_column);
  end loop;
end
$$;

grant select (id, product_id, rating, approved) on table public.reviews to anon, authenticated;

revoke truncate, trigger, references on table public.reviews from anon, authenticated;
revoke delete on table public.reviews from anon;

-- 2. Destacado sólo para experiencias generales ------------------------------

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

    -- El Home sólo muestra experiencias generales: una reseña de producto
    -- nunca se destaca (quitar el destacado sí se permite).
    if new.featured and new.product_id is not null then
      raise exception 'REVIEW_FEATURED_EXPERIENCE_ONLY' using errcode = '23514';
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
