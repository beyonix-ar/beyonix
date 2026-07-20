-- Seguimiento e idempotencia de los correos de Gift Card.
-- No modifica el SMTP de Supabase Auth ni crea un segundo sistema de Gift Cards.

alter table public.customer_gift_cards
  add column if not exists email_status text not null default 'pending',
  add column if not exists email_sent_at timestamptz,
  add column if not exists email_last_attempt_at timestamptz,
  add column if not exists email_attempts integer not null default 0,
  add column if not exists email_last_error text,
  add column if not exists email_provider_id text;

alter table public.customer_gift_cards
  drop constraint if exists customer_gift_cards_email_status_check;

alter table public.customer_gift_cards
  add constraint customer_gift_cards_email_status_check
  check (email_status in ('pending', 'sending', 'sent', 'error'));

create or replace function public.reserve_customer_gift_card_email_delivery(
  p_gift_card_id uuid
)
returns table (
  reserved boolean,
  current_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.customer_gift_cards%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select *
  into v_card
  from public.customer_gift_cards
  where id = p_gift_card_id
  for update;

  if not found then
    raise exception 'GIFT_CARD_NOT_FOUND';
  end if;

  if v_card.status not in ('sent', 'claimed') then
    return query select false, v_card.email_status;
    return;
  end if;

  if v_card.expires_at <= now() then
    return query select false, v_card.email_status;
    return;
  end if;

  if v_card.email_status = 'sent' then
    return query select false, v_card.email_status;
    return;
  end if;

  if v_card.email_status = 'sending'
     and v_card.email_last_attempt_at > now() - interval '5 minutes' then
    return query select false, v_card.email_status;
    return;
  end if;

  update public.customer_gift_cards
  set email_status = 'sending',
      email_last_attempt_at = now(),
      email_attempts = email_attempts + 1,
      email_last_error = null,
      updated_at = now()
  where id = p_gift_card_id;

  return query select true, 'sending'::text;
end;
$$;

create or replace function public.complete_customer_gift_card_email_delivery(
  p_gift_card_id uuid,
  p_success boolean,
  p_provider_id text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  update public.customer_gift_cards
  set email_status = case when p_success then 'sent' else 'error' end,
      email_sent_at = case when p_success then now() else email_sent_at end,
      email_provider_id = case when p_success then nullif(p_provider_id, '') else email_provider_id end,
      email_last_error = case when p_success then null else left(coalesce(p_error, 'Error de entrega'), 500) end,
      updated_at = now()
  where id = p_gift_card_id
    and email_status = 'sending';
end;
$$;

revoke all on function public.reserve_customer_gift_card_email_delivery(uuid) from public;
revoke all on function public.complete_customer_gift_card_email_delivery(uuid, boolean, text, text) from public;
grant execute on function public.reserve_customer_gift_card_email_delivery(uuid) to service_role;
grant execute on function public.complete_customer_gift_card_email_delivery(uuid, boolean, text, text) to service_role;

