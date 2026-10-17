-- Numeración visible de Bultos nuevos. Los DSP históricos conservan NULL.
create sequence public.dispatch_batch_display_number_seq as bigint start with 1;

alter table public.dispatch_batches
  add column display_number bigint;

alter sequence public.dispatch_batch_display_number_seq
  owned by public.dispatch_batches.display_number;

alter table public.dispatch_batches
  alter column display_number set default nextval('public.dispatch_batch_display_number_seq'::regclass),
  add constraint dispatch_batches_display_number_positive check (display_number > 0);

create unique index dispatch_batches_display_number_unique
  on public.dispatch_batches(display_number) where display_number is not null;

comment on column public.dispatch_batches.display_number is
  'Número correlativo visible de Bultos nuevos; NULL en los DSP históricos.';
