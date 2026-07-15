alter table public.customer_notification_campaigns
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz;

alter table public.customer_notifications
  add column if not exists target_items jsonb not null default '[]'::jsonb,
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz;

create index if not exists customer_notifications_visibility_window_idx
  on public.customer_notifications (user_id, starts_at, ends_at, created_at desc)
  where dismissed_at is null;
