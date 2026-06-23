alter table public.order_claims
  add column if not exists first_reviewed_at timestamptz,
  add column if not exists first_reviewed_by uuid references auth.users(id) on delete set null;

comment on column public.order_claims.first_reviewed_at is
  'Fecha y hora en que un administrador abrió el reclamo por primera vez.';

comment on column public.order_claims.first_reviewed_by is
  'Administrador u operador que abrió el reclamo por primera vez.';
