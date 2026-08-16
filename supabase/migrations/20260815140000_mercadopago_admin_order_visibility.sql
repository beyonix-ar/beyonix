-- Separa los intentos técnicos de Mercado Pago de los pedidos que ya deben
-- incorporarse al flujo operativo del administrador.

alter table public.ordenes
  add column if not exists admin_visible_at timestamptz default now();

update public.ordenes
set admin_visible_at = null
where payment_method_id = 'mercadopago'
  and not (
    payment_status = 'approved'
    and financial_status in (
      'payment_confirmed',
      'cancellation_requested',
      'refund_pending',
      'refunded'
    )
    and payment_confirmed_at is not null
    and payment_id is not null
  );

update public.ordenes
set admin_visible_at = coalesce(payment_confirmed_at, paid_at, created_at)
where payment_method_id = 'mercadopago'
  and payment_status = 'approved'
  and financial_status in (
    'payment_confirmed',
    'cancellation_requested',
    'refund_pending',
    'refunded'
  )
  and payment_confirmed_at is not null
  and payment_id is not null;

update public.ordenes
set admin_visible_at = created_at
where payment_method_id is distinct from 'mercadopago';

alter table public.ordenes
  drop constraint if exists ordenes_admin_visibility_payment_check;
alter table public.ordenes
  add constraint ordenes_admin_visibility_payment_check check (
    payment_method_id is distinct from 'mercadopago'
    or admin_visible_at is null
    or (
      payment_status = 'approved'
      and financial_status in (
        'payment_confirmed',
        'cancellation_requested',
        'refund_pending',
        'refunded'
      )
      and payment_confirmed_at is not null
      and payment_id is not null
    )
  );

create index if not exists ordenes_admin_visible_at_idx
  on public.ordenes (admin_visible_at desc)
  where admin_visible_at is not null;

comment on column public.ordenes.admin_visible_at is
  'Momento en que una orden deja de ser un intento técnico y entra al flujo operativo del administrador.';

notify pgrst, 'reload schema';
