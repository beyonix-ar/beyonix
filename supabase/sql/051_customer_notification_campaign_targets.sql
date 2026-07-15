alter table public.customer_notification_campaigns
  add column if not exists target_scope text not null default 'store'
    check (target_scope in ('store', 'category', 'product', 'general')),
  add column if not exists target_items jsonb not null default '[]'::jsonb;
