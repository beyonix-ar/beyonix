create table if not exists public.customer_gift_cards (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references auth.users(id) on delete restrict,
  recipient_user_id uuid references auth.users(id) on delete set null,
  recipient_email text not null,
  recipient_name text not null,
  sender_name text not null,
  initial_amount numeric(12, 2) not null check (initial_amount > 0),
  message text not null default '',
  display_code text not null unique,
  claim_token_hash text not null unique,
  status text not null default 'sent'
    check (status in ('sent', 'claimed', 'expired', 'cancelled')),
  debit_movement_id uuid references public.customer_credit_movements(id) on delete restrict,
  credit_movement_id uuid references public.customer_credit_movements(id) on delete set null,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_gift_cards_email_check check (
    recipient_email = lower(trim(recipient_email))
    and length(recipient_email) <= 320
    and position('@' in recipient_email) > 1
  ),
  constraint customer_gift_cards_names_check check (
    length(trim(recipient_name)) between 2 and 120
    and length(trim(sender_name)) between 2 and 120
  ),
  constraint customer_gift_cards_message_check check (length(message) <= 240)
);

create index if not exists customer_gift_cards_sender_idx
  on public.customer_gift_cards (sender_user_id, created_at desc);
create index if not exists customer_gift_cards_recipient_idx
  on public.customer_gift_cards (recipient_user_id, created_at desc);
create index if not exists customer_gift_cards_email_status_idx
  on public.customer_gift_cards (recipient_email, status, created_at desc);

alter table public.customer_gift_cards enable row level security;

drop policy if exists "Customers can read related gift cards"
  on public.customer_gift_cards;
create policy "Customers can read related gift cards"
on public.customer_gift_cards
for select
to authenticated
using (
  sender_user_id = auth.uid()
  or recipient_user_id = auth.uid()
  or public.current_user_role() in ('admin', 'super_admin')
);

revoke all on public.customer_gift_cards from anon, authenticated;
grant select on public.customer_gift_cards to authenticated;

create or replace function public.create_claimable_customer_gift_card(
  p_sender_user_id uuid,
  p_recipient_email text,
  p_recipient_name text,
  p_sender_name text,
  p_amount numeric,
  p_message text,
  p_display_code text,
  p_claim_token_hash text,
  p_expires_at timestamptz
)
returns table (
  gift_card_id uuid,
  resulting_balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(12, 2);
  v_balance numeric(12, 2);
  v_card public.customer_gift_cards%rowtype;
  v_debit public.customer_credit_movements%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para crear Gift Cards.';
  end if;

  v_amount := round(coalesce(p_amount, 0)::numeric, 2);
  if p_sender_user_id is null or v_amount <= 0 then
    raise exception 'INVALID_GIFT_CARD_AMOUNT';
  end if;
  if trim(coalesce(p_recipient_email, '')) !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'INVALID_GIFT_CARD_EMAIL';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'INVALID_GIFT_CARD_EXPIRATION';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer-credit:' || p_sender_user_id::text));
  select public.get_customer_credit_balance(p_sender_user_id) into v_balance;
  if v_amount > v_balance then
    raise exception 'INSUFFICIENT_CUSTOMER_CREDIT';
  end if;

  insert into public.customer_gift_cards (
    sender_user_id, recipient_email, recipient_name, sender_name,
    initial_amount, message, display_code, claim_token_hash, expires_at
  ) values (
    p_sender_user_id, lower(trim(p_recipient_email)), trim(p_recipient_name),
    trim(p_sender_name), v_amount, trim(coalesce(p_message, '')),
    trim(p_display_code), p_claim_token_hash, p_expires_at
  ) returning * into v_card;

  insert into public.customer_credit_movements (
    user_id, movement_type, amount, description, source_type, source_id,
    created_by, source_key, resulting_balance, metadata
  ) values (
    p_sender_user_id, 'debit', v_amount,
    'Gift Card enviada a ' || v_card.recipient_name,
    'admin_adjustment', v_card.id::text, p_sender_user_id,
    'claimable-gift-card:' || v_card.id || ':debit', v_balance - v_amount,
    jsonb_build_object(
      'created_from', 'customer_gift_card',
      'source_kind', 'gift_card',
      'gift_card_id', v_card.id,
      'recipient_email', v_card.recipient_email,
      'recipient_name', v_card.recipient_name,
      'message', v_card.message,
      'claim_status', 'sent'
    )
  ) returning * into v_debit;

  update public.customer_gift_cards
  set debit_movement_id = v_debit.id, updated_at = now()
  where id = v_card.id;

  gift_card_id := v_card.id;
  resulting_balance := v_balance - v_amount;
  return next;
end;
$$;

revoke all on function public.create_claimable_customer_gift_card(
  uuid, text, text, text, numeric, text, text, text, timestamptz
) from public;
grant execute on function public.create_claimable_customer_gift_card(
  uuid, text, text, text, numeric, text, text, text, timestamptz
) to service_role;

create or replace function public.claim_customer_gift_card(
  p_gift_card_id uuid,
  p_recipient_user_id uuid
)
returns table (
  credit_movement_id uuid,
  resulting_balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.customer_gift_cards%rowtype;
  v_balance numeric(12, 2);
  v_credit public.customer_credit_movements%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para reclamar Gift Cards.';
  end if;

  perform pg_advisory_xact_lock(hashtext('gift-card-claim:' || p_gift_card_id::text));
  perform pg_advisory_xact_lock(hashtext('customer-credit:' || p_recipient_user_id::text));

  select * into v_card
  from public.customer_gift_cards
  where id = p_gift_card_id
  for update;

  if not found then raise exception 'GIFT_CARD_NOT_FOUND'; end if;
  if v_card.status = 'claimed' then raise exception 'GIFT_CARD_ALREADY_CLAIMED'; end if;
  if v_card.status <> 'sent' then raise exception 'GIFT_CARD_NOT_AVAILABLE'; end if;
  if v_card.expires_at <= now() then
    raise exception 'GIFT_CARD_EXPIRED';
  end if;

  select public.get_customer_credit_balance(p_recipient_user_id) into v_balance;
  insert into public.customer_credit_movements (
    user_id, movement_type, amount, description, source_type, source_id,
    created_by, expires_at, source_key, resulting_balance, metadata
  ) values (
    p_recipient_user_id, 'credit', v_card.initial_amount,
    'Gift Card recibida: ' || coalesce(nullif(v_card.message, ''), 'Un regalo para vos'),
    'admin_adjustment', v_card.id::text, v_card.sender_user_id, v_card.expires_at,
    'claimable-gift-card:' || v_card.id || ':credit',
    v_balance + v_card.initial_amount,
    jsonb_build_object(
      'created_from', 'customer_gift_card',
      'source_kind', 'gift_card',
      'gift_card_id', v_card.id,
      'sender_user_id', v_card.sender_user_id,
      'sender_name', v_card.sender_name,
      'message', v_card.message,
      'display_code', v_card.display_code
    )
  ) returning * into v_credit;

  update public.customer_gift_cards
  set status = 'claimed', recipient_user_id = p_recipient_user_id,
      credit_movement_id = v_credit.id, claimed_at = now(), updated_at = now()
  where id = v_card.id;

  credit_movement_id := v_credit.id;
  resulting_balance := v_balance + v_card.initial_amount;
  return next;
end;
$$;

revoke all on function public.claim_customer_gift_card(uuid, uuid) from public;
grant execute on function public.claim_customer_gift_card(uuid, uuid) to service_role;

create or replace function public.cancel_unclaimed_customer_gift_card(
  p_gift_card_id uuid,
  p_reason text default 'No se pudo entregar el email de la Gift Card'
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card public.customer_gift_cards%rowtype;
  v_balance numeric(12, 2);
  v_refund public.customer_credit_movements%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para cancelar Gift Cards.';
  end if;

  perform pg_advisory_xact_lock(hashtext('gift-card-claim:' || p_gift_card_id::text));
  select * into v_card
  from public.customer_gift_cards
  where id = p_gift_card_id
  for update;

  if not found then raise exception 'GIFT_CARD_NOT_FOUND'; end if;
  if v_card.status = 'cancelled' then
    return public.get_customer_credit_balance(v_card.sender_user_id);
  end if;
  if v_card.status <> 'sent' then raise exception 'GIFT_CARD_CANNOT_BE_CANCELLED'; end if;

  perform pg_advisory_xact_lock(hashtext('customer-credit:' || v_card.sender_user_id::text));
  select public.get_customer_credit_balance(v_card.sender_user_id) into v_balance;

  insert into public.customer_credit_movements (
    user_id, movement_type, amount, description, source_type, source_id,
    created_by, related_movement_id, source_key, resulting_balance, metadata
  ) values (
    v_card.sender_user_id, 'reversal', v_card.initial_amount,
    'Reintegro de Gift Card no entregada', 'reversal', v_card.id::text,
    v_card.sender_user_id, v_card.debit_movement_id,
    'claimable-gift-card:' || v_card.id || ':delivery-refund',
    v_balance + v_card.initial_amount,
    jsonb_build_object(
      'created_from', 'customer_gift_card',
      'source_kind', 'gift_card',
      'gift_card_id', v_card.id,
      'reason', trim(coalesce(p_reason, 'No se pudo entregar el email'))
    )
  ) returning * into v_refund;

  update public.customer_gift_cards
  set status = 'cancelled', updated_at = now()
  where id = v_card.id;

  return v_refund.resulting_balance;
end;
$$;

revoke all on function public.cancel_unclaimed_customer_gift_card(uuid, text) from public;
grant execute on function public.cancel_unclaimed_customer_gift_card(uuid, text) to service_role;

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'customer_gift_cards'
  ) then
    alter publication supabase_realtime add table public.customer_gift_cards;
  end if;
end $$;
