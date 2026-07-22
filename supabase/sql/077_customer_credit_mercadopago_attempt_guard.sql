-- Impide que solicitudes concurrentes generen más de una carga activa por
-- cliente. Los intentos anteriores quedan como cancelados y no se muestran en
-- el historial público.

with ranked_pending as (
  select
    id,
    row_number() over (
      partition by user_id
      order by created_at desc, id desc
    ) as position
  from public.customer_credit_topups
  where payment_method = 'mercadopago'
    and status = 'pendiente_pago'
)
update public.customer_credit_topups as topup
set
  status = 'cancelado',
  mercadopago_status = 'deduplicated_by_migration',
  updated_at = now()
from ranked_pending
where topup.id = ranked_pending.id
  and ranked_pending.position > 1;

create unique index if not exists customer_credit_topups_one_active_mp_idx
  on public.customer_credit_topups (user_id)
  where payment_method = 'mercadopago'
    and status = 'pendiente_pago';
