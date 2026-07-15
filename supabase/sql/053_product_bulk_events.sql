create table if not exists public.product_bulk_events (
  id uuid primary key default gen_random_uuid(),
  internal_name text not null,
  starts_on date null,
  duration_days integer null,
  scope text not null default 'product',
  target_items jsonb not null default '[]'::jsonb,
  action_kind text not null,
  value numeric null,
  installments integer null,
  status text not null default 'draft',
  activated_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  updated_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_bulk_events_scope_check
    check (scope in ('store', 'category', 'product')),
  constraint product_bulk_events_action_kind_check
    check (action_kind in (
      'discount_percent',
      'price_increase_percent',
      'price_decrease_percent',
      'installments',
      'clear_offer'
    )),
  constraint product_bulk_events_status_check
    check (status in ('draft', 'active')),
  constraint product_bulk_events_duration_check
    check (duration_days is null or duration_days between 1 and 365),
  constraint product_bulk_events_value_check
    check (value is null or value between 1 and 99),
  constraint product_bulk_events_installments_check
    check (installments is null or installments in (3, 6))
);

create index if not exists product_bulk_events_status_idx
  on public.product_bulk_events(status);

create index if not exists product_bulk_events_created_at_idx
  on public.product_bulk_events(created_at desc);

