alter table public.order_claims
  add column if not exists last_customer_message_at timestamptz,
  add column if not exists last_admin_response_at timestamptz,
  add column if not exists admin_needs_action boolean not null default false;

update public.order_claims claim
set
  last_customer_message_at = messages.last_customer_message_at,
  last_admin_response_at = messages.last_admin_response_at,
  admin_needs_action =
    messages.last_customer_message_at is not null
    and messages.last_customer_message_at > coalesce(messages.last_admin_response_at, '-infinity'::timestamptz)
    and claim.status not in ('aprobado', 'cerrado', 'rechazado')
from (
  select
    claim_id,
    max(created_at) filter (where author_role = 'cliente') as last_customer_message_at,
    max(created_at) filter (where author_role <> 'cliente') as last_admin_response_at
  from public.order_claim_messages
  group by claim_id
) messages
where messages.claim_id = claim.id;

create or replace function public.sync_order_claim_admin_attention()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_role = 'cliente' then
    update public.order_claims
    set last_customer_message_at = new.created_at,
        admin_needs_action = true
    where id = new.claim_id
      and status not in ('cerrado', 'rechazado');
  else
    update public.order_claims
    set last_admin_response_at = new.created_at,
        admin_needs_action = false
    where id = new.claim_id;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_order_claim_admin_attention_trigger
  on public.order_claim_messages;

create trigger sync_order_claim_admin_attention_trigger
after insert on public.order_claim_messages
for each row execute function public.sync_order_claim_admin_attention();

create or replace function public.clear_resolved_order_claim_attention()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('aprobado', 'cerrado', 'rechazado') then
    new.admin_needs_action := false;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_resolved_order_claim_attention_trigger
  on public.order_claims;

create trigger clear_resolved_order_claim_attention_trigger
before insert or update of status on public.order_claims
for each row execute function public.clear_resolved_order_claim_attention();

create index if not exists order_claims_admin_needs_action_idx
  on public.order_claims (admin_needs_action, order_id)
  where admin_needs_action = true;
