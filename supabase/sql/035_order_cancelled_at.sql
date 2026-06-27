alter table public.ordenes
  add column if not exists cancelled_at timestamptz;

create index if not exists ordenes_cancelled_at_idx
  on public.ordenes (cancelled_at)
  where cancelled_at is not null;
