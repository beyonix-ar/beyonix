alter table public.ordenes
  add column if not exists invoice_number bigint,
  add column if not exists invoice_point integer,
  add column if not exists invoice_cae text,
  add column if not exists invoice_cae_due date,
  add column if not exists invoice_status text,
  add column if not exists invoice_created_at timestamptz;

create unique index if not exists ordenes_invoice_number_unique
  on public.ordenes (invoice_point, invoice_number)
  where invoice_point is not null and invoice_number is not null;

alter table public.ordenes
  drop constraint if exists ordenes_invoice_status_check;

alter table public.ordenes
  add constraint ordenes_invoice_status_check
  check (
    invoice_status is null
    or invoice_status in ('processing', 'authorized', 'error')
  );
