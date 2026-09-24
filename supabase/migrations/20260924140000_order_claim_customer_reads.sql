-- Lectura de respuestas de BEYONIX por el cliente, para:
--   * el badge numérico de "Ver reclamo" en Mis compras (mensajes de BEYONIX
--     posteriores a la última lectura del cliente);
--   * marcar como leídas las notificaciones "claim_response" de la campana
--     cuando el cliente efectivamente ve la conversación.
--
-- Por qué una tabla aparte y no una columna en order_claims: el trigger
-- touch_order_claim_updated_at actualiza order_claims.updated_at en CUALQUIER
-- UPDATE. Guardar ahí la lectura cambiaría updated_at cada vez que el cliente
-- abre el reclamo: rompería el control de concurrencia (expectedUpdatedAt) de
-- la próxima respuesta y el polling del admin lo tomaría como un cambio.
--
-- Históricos (sin dato de lectura previo): se toma como leído todo lo que el
-- cliente ya vio o ya no tiene pendiente en la campana -- nunca se marcan de
-- golpe todas las respuestas viejas como nuevas. Ver el backfill abajo.

begin;

create table if not exists public.order_claim_customer_reads (
  claim_id bigint primary key references public.order_claims(id) on delete cascade,
  user_id uuid not null,
  last_read_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists order_claim_customer_reads_user_id_idx
  on public.order_claim_customer_reads (user_id);

alter table public.order_claim_customer_reads enable row level security;
revoke all on public.order_claim_customer_reads from public, anon, authenticated;
grant select, insert, update on public.order_claim_customer_reads to service_role;

comment on table public.order_claim_customer_reads is
  'Hasta qué momento el cliente titular leyó las respuestas de BEYONIX de cada reclamo. Sólo se escribe server-side (mark_order_claim_customer_read) tras verificar la titularidad; nunca desde el navegador.';

-- Backfill de reclamos existentes con titular:
--   last_read_at = la más reciente entre
--     * la creación del reclamo;
--     * el último mensaje del cliente (si respondió, vio lo anterior);
--     * la última respuesta de BEYONIX cuya notificación ya no está pendiente
--       en la campana (leída, descartada o inexistente -- mensajes anteriores
--       a las notificaciones).
-- Así sólo quedan como "nuevas" las respuestas que la campana ya muestra como
-- no leídas: badge y campana arrancan consistentes.
insert into public.order_claim_customer_reads (claim_id, user_id, last_read_at)
select
  c.id,
  c.user_id,
  greatest(
    c.created_at,
    coalesce(c.last_customer_message_at, c.created_at),
    coalesce(
      (
        select max(m.created_at)
        from public.order_claim_messages m
        where m.claim_id = c.id
          and m.author_role <> 'cliente'
          and not exists (
            select 1
            from public.customer_notifications n
            where n.source_key = 'claim-message:' || m.id
              and n.is_read = false
              and n.dismissed_at is null
          )
      ),
      c.created_at
    )
  )
from public.order_claims c
where c.user_id is not null
on conflict (claim_id) do nothing;

-- Marca como leído hasta p_read_at (nunca retrocede) y marca como leídas las
-- notificaciones "BEYONIX respondió tu reclamo" de ese pedido que ya estaban
-- disponibles en ese momento. Titularidad verificada acá también (defensa en
-- profundidad: el endpoint ya la valida).
create or replace function public.mark_order_claim_customer_read(
  p_claim_id bigint,
  p_user_id uuid,
  p_read_at timestamptz
)
returns timestamptz
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_claim public.order_claims%rowtype;
  v_last_read timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  select * into v_claim from public.order_claims where id = p_claim_id;
  if not found or v_claim.user_id is distinct from p_user_id or p_read_at is null then
    raise exception 'CLAIM_FORBIDDEN';
  end if;

  insert into public.order_claim_customer_reads as r (claim_id, user_id, last_read_at)
  values (p_claim_id, p_user_id, p_read_at)
  on conflict (claim_id) do update
    set last_read_at = greatest(r.last_read_at, excluded.last_read_at),
        updated_at = now()
  returning r.last_read_at into v_last_read;

  update public.customer_notifications
  set is_read = true
  where user_id = p_user_id
    and type = 'claim_response'
    and order_id = v_claim.order_id
    and is_read = false
    and created_at <= v_last_read;

  return v_last_read;
end;
$$;

revoke all on function public.mark_order_claim_customer_read(bigint, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_order_claim_customer_read(bigint, uuid, timestamptz)
  to service_role;

-- Notificación de respuesta: texto claro con el pedido y consolidada. Si ya
-- hay una "BEYONIX respondió tu reclamo" sin leer para ese pedido, se
-- actualiza (sube arriba en la campana) en vez de sumar otra: el conteo real
-- de mensajes nuevos lo da el badge de "Ver reclamo".
create or replace function public.notify_customer_claim_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_title text := 'BEYONIX respondió tu reclamo';
  v_body text;
  -- Mismo tipo que customer_notifications.id (uuid en producción): nunca
  -- fijarlo a mano -- un tipo distinto hace fallar el trigger y, con él, el
  -- INSERT del mensaje del admin.
  v_existing public.customer_notifications.id%type;
begin
  if new.author_role = 'cliente' then return new; end if;
  select * into v_claim from public.order_claims where id = new.claim_id;
  if v_claim.user_id is null then return new; end if;

  v_body := 'Tenés un nuevo mensaje sobre el pedido #BX-' || (1000 + v_claim.order_id) || '.';

  select id into v_existing
  from public.customer_notifications
  where user_id = v_claim.user_id
    and type = 'claim_response'
    and order_id = v_claim.order_id
    and is_read = false
    and dismissed_at is null
  order by created_at desc
  limit 1;

  if v_existing is not null then
    update public.customer_notifications
    set title = v_title, body = v_body, created_at = now()
    where id = v_existing;
  else
    insert into public.customer_notifications(user_id, type, title, body, action_url, order_id, source_key)
    values (
      v_claim.user_id, 'claim_response', v_title, v_body,
      '/cuenta/compras/' || v_claim.order_id || '/ayuda',
      v_claim.order_id, 'claim-message:' || new.id
    )
    on conflict (source_key) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.notify_customer_claim_message() from public, anon, authenticated;

-- Mismo nombre que el trigger existente (supabase/sql/028): se reemplaza, no
-- se duplica.
drop trigger if exists notify_customer_claim_message_trigger on public.order_claim_messages;
create trigger notify_customer_claim_message_trigger
after insert on public.order_claim_messages
for each row execute function public.notify_customer_claim_message();

commit;
