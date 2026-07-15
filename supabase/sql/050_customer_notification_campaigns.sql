alter table public.customer_notifications
  add column if not exists dismissed_at timestamptz;

create index if not exists customer_notifications_user_visible_idx
  on public.customer_notifications (user_id, created_at desc)
  where dismissed_at is null;

grant update (is_read, dismissed_at) on public.customer_notifications to authenticated;

create table if not exists public.customer_notification_campaigns (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'oferta'
    check (type in (
      'promocion',
      'descuento',
      'evento',
      'oferta',
      'cuotas',
      'producto_destacado',
      'mensaje'
    )),
  title text not null check (char_length(trim(title)) between 3 and 80),
  body text not null check (char_length(trim(body)) between 8 and 220),
  action_url text,
  status text not null default 'draft'
    check (status in ('draft', 'published')),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_notification_campaigns_status_idx
  on public.customer_notification_campaigns (status, updated_at desc);

alter table public.customer_notification_campaigns enable row level security;

drop policy if exists "Admins can read notification campaigns"
  on public.customer_notification_campaigns;
create policy "Admins can read notification campaigns"
on public.customer_notification_campaigns
for select
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

drop policy if exists "Admins can manage notification campaigns"
  on public.customer_notification_campaigns;
create policy "Admins can manage notification campaigns"
on public.customer_notification_campaigns
for all
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'))
with check (public.current_user_role() in ('admin', 'super_admin'));

revoke all on public.customer_notification_campaigns from anon, authenticated;
grant select, insert, update, delete on public.customer_notification_campaigns to authenticated;

create or replace function public.touch_customer_notification_campaigns_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_customer_notification_campaigns_updated_at_trigger
  on public.customer_notification_campaigns;
create trigger touch_customer_notification_campaigns_updated_at_trigger
before update on public.customer_notification_campaigns
for each row
execute function public.touch_customer_notification_campaigns_updated_at();
