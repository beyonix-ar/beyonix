alter table public.ordenes
  add column if not exists invoice_error text;

alter table public.ordenes
  drop constraint if exists ordenes_invoice_status_check;

alter table public.ordenes
  add constraint ordenes_invoice_status_check
  check (
    invoice_status is null
    or invoice_status in ('pending', 'processing', 'authorized', 'error')
  );
