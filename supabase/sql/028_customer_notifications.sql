create table if not exists public.customer_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null,
  action_url text,
  order_id bigint references public.ordenes(id) on delete cascade,
  is_read boolean not null default false,
  source_key text unique,
  created_at timestamptz not null default now()
);

create index if not exists customer_notifications_user_created_idx
  on public.customer_notifications (user_id, created_at desc);

create index if not exists customer_notifications_user_unread_idx
  on public.customer_notifications (user_id, created_at desc)
  where is_read = false;

alter table public.customer_notifications enable row level security;

drop policy if exists "Customers can read own notifications"
  on public.customer_notifications;
create policy "Customers can read own notifications"
on public.customer_notifications
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Customers can mark own notifications as read"
  on public.customer_notifications;
create policy "Customers can mark own notifications as read"
on public.customer_notifications
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Admins can create customer notifications"
  on public.customer_notifications;
create policy "Admins can create customer notifications"
on public.customer_notifications
for insert
to authenticated
with check (
  public.current_user_role() in ('admin', 'super_admin')
);

revoke all on public.customer_notifications from anon, authenticated;
grant select, insert on public.customer_notifications to authenticated;
grant update (is_read) on public.customer_notifications to authenticated;

insert into public.customer_notifications (
  user_id,
  type,
  title,
  body,
  action_url,
  order_id,
  source_key
)
select
  ordenes.usuario_id,
  'payment_proof_pending',
  'Comprobante pendiente',
  'Subí el comprobante para que podamos validar tu pago.',
  '/checkout/success?method=transferencia&order_id=' || ordenes.id,
  ordenes.id,
  'order:' || ordenes.id || ':payment-proof-pending'
from public.ordenes
where ordenes.usuario_id is not null
  and ordenes.payment_method_id = 'transferencia'
  and coalesce(ordenes.payment_status, '') = 'pendiente_comprobante'
  and ordenes.payment_proof_url is null
on conflict (source_key) do nothing;

create or replace function public.notify_customer_order_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.usuario_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.payment_method_id = 'transferencia'
       and coalesce(new.payment_status, '') = 'pendiente_comprobante' then
      insert into public.customer_notifications (
        user_id,
        type,
        title,
        body,
        action_url,
        order_id,
        source_key
      ) values (
        new.usuario_id,
        'payment_proof_pending',
        'Comprobante pendiente',
        'Subí el comprobante para que podamos validar tu pago.',
        '/checkout/success?method=transferencia&order_id=' || new.id,
        new.id,
        'order:' || new.id || ':payment-proof-pending'
      )
      on conflict (source_key) do nothing;
    end if;

    return new;
  end if;

  if old.payment_status is distinct from new.payment_status
     and new.payment_status = 'confirmado' then
    insert into public.customer_notifications (
      user_id, type, title, body, action_url, order_id, source_key
    ) values (
      new.usuario_id,
      'payment_validated',
      'Pago validado',
      'Confirmamos tu pago y comenzaremos a preparar tu pedido.',
      '/cuenta?tab=ordenes',
      new.id,
      'order:' || new.id || ':payment-validated'
    )
    on conflict (source_key) do nothing;
  end if;

  if old.estado is distinct from new.estado then
    if new.estado in ('enviado', 'en_camino') then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_shipped',
        'Pedido enviado',
        'Tu pedido ya está en camino.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':shipped'
      )
      on conflict (source_key) do nothing;
    elsif new.estado = 'entregado' then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_delivered',
        'Pedido entregado',
        'Tu pedido figura como entregado.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':delivered'
      )
      on conflict (source_key) do nothing;
    elsif new.estado = 'cancelado' then
      insert into public.customer_notifications (
        user_id, type, title, body, action_url, order_id, source_key
      ) values (
        new.usuario_id,
        'order_status',
        'Actualización de tu pedido',
        'El estado de tu pedido cambió. Revisá el detalle para más información.',
        '/cuenta?tab=ordenes',
        new.id,
        'order:' || new.id || ':cancelled'
      )
      on conflict (source_key) do nothing;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists notify_customer_order_changes_trigger
  on public.ordenes;
create trigger notify_customer_order_changes_trigger
after insert or update of payment_status, estado
on public.ordenes
for each row
execute function public.notify_customer_order_changes();

create or replace function public.notify_customer_claim_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claim_user_id uuid;
  claim_order_id bigint;
begin
  if new.author_role = 'cliente' then
    return new;
  end if;

  select user_id, order_id
  into claim_user_id, claim_order_id
  from public.order_claims
  where id = new.claim_id;

  if claim_user_id is null then
    return new;
  end if;

  insert into public.customer_notifications (
    user_id,
    type,
    title,
    body,
    action_url,
    order_id,
    source_key
  ) values (
    claim_user_id,
    'claim_response',
    'Mensaje de BEYONIX',
    'Tenés una nueva respuesta sobre tu pedido.',
    '/cuenta?tab=ordenes',
    claim_order_id,
    'claim-message:' || new.id
  )
  on conflict (source_key) do nothing;

  return new;
end;
$$;

drop trigger if exists notify_customer_claim_message_trigger
  on public.order_claim_messages;
create trigger notify_customer_claim_message_trigger
after insert
on public.order_claim_messages
for each row
execute function public.notify_customer_claim_message();

create or replace function public.notify_customers_about_offer(
  offer_title text default 'Oferta disponible',
  offer_body text default 'Hay una nueva oferta activa en la tienda.',
  offer_action_url text default '/productos'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
begin
  if public.current_user_role() not in ('admin', 'super_admin') then
    raise exception 'No tenés permisos para publicar notificaciones de ofertas.';
  end if;

  insert into public.customer_notifications (
    user_id,
    type,
    title,
    body,
    action_url
  )
  select
    profiles.id,
    'offer',
    offer_title,
    offer_body,
    offer_action_url
  from public.profiles
  where profiles.rol = 'cliente';

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.notify_customers_about_offer(text, text, text)
  from public;
grant execute on function public.notify_customers_about_offer(text, text, text)
  to authenticated;

do $$
begin
  alter publication supabase_realtime
    add table public.customer_notifications;
exception
  when duplicate_object then null;
end;
$$;
