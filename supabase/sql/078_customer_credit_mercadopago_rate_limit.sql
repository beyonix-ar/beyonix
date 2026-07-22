-- Huella irreversible del origen para limitar automatizaciones sin almacenar
-- la dirección IP en texto legible.

alter table public.customer_credit_topups
  add column if not exists request_fingerprint text;

create index if not exists customer_credit_topups_mp_user_created_idx
  on public.customer_credit_topups (user_id, created_at desc)
  where payment_method = 'mercadopago';

create index if not exists customer_credit_topups_mp_fingerprint_created_idx
  on public.customer_credit_topups (request_fingerprint, created_at desc)
  where payment_method = 'mercadopago'
    and request_fingerprint is not null;

comment on column public.customer_credit_topups.request_fingerprint is
  'Hash irreversible del origen de la solicitud usado exclusivamente para prevención de abuso.';
