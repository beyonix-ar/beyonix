-- Analítica comercial (2/3): compras confirmadas y relación sesión ↔ orden.
--
-- purchase_completed NUNCA viene del navegador. La fuente de verdad es la
-- orden: un trigger sobre public.ordenes registra la compra la primera vez que
-- la orden cumple la misma regla que el Dashboard usa para "venta cobrada"
-- (isDashboardPaidSale en lib/business/dashboard-financials.ts, basada en
-- isOrderPaymentConfirmed). Así cubre Mercado Pago, transferencia (automática
-- o manual), confirmación del Admin y saldo a favor sin tocar cada flujo.
--
--   * Idempotencia autoritativa: order_id es la PK de analytics_purchases y el
--     insert es ON CONFLICT DO NOTHING. Webhooks repetidos, reintentos,
--     reprocesos o dos confirmaciones en carrera generan una sola compra.
--   * Una venta cobrada y luego cancelada/reintegrada sigue siendo una compra
--     (como en el Dashboard; la reversión se mide aparte). Una orden cancelada,
--     pendiente o rechazada sin pago confirmado nunca genera compra, y los
--     pagos aprobados que no son venta (después de cancelar, conflicto de
--     stock, monto o moneda) tampoco.
--   * Analítica nunca bloquea un pago: cualquier error del registro se
--     descarta con un WARNING y la actualización de la orden sigue.
--   * Sin reconstrucción histórica: sólo registra confirmaciones desde ahora.
--
-- analytics_order_sessions vincula la orden con la sesión de Analítica que la
-- creó (la escriben las rutas de checkout del servidor, nunca el público). Es
-- distinta de la sesión de reserva de stock (cartSessionId). Una orden sin
-- sesión (Admin, sesión perdida, órdenes previas) es una compra completada,
-- pero no atribuible: no entra al funnel.

begin;

create table if not exists public.analytics_order_sessions (
  order_id bigint primary key references public.ordenes(id) on delete cascade,
  session_id uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists analytics_order_sessions_session_idx
  on public.analytics_order_sessions (session_id);

alter table public.analytics_order_sessions enable row level security;
revoke all on table public.analytics_order_sessions from public, anon, authenticated;
grant select, insert, delete on table public.analytics_order_sessions to service_role;

comment on table public.analytics_order_sessions is
  'Orden -> sesión de Analítica que la creó (escrita server-side por el checkout). No es la sesión de reserva de stock.';

create table if not exists public.analytics_purchases (
  order_id bigint primary key references public.ordenes(id) on delete cascade,
  user_id uuid,
  -- Total de la orden al confirmarse el pago (bruto, como el Dashboard: original_total o total).
  revenue numeric(14, 2) not null check (revenue >= 0),
  confirmed_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

create index if not exists analytics_purchases_confirmed_idx
  on public.analytics_purchases (confirmed_at desc);

alter table public.analytics_purchases enable row level security;
revoke all on table public.analytics_purchases from public, anon, authenticated;
grant select on table public.analytics_purchases to service_role;

comment on table public.analytics_purchases is
  'purchase_completed: una fila por orden con pago confirmado (misma regla que la venta cobrada del Dashboard). Sólo la escribe el trigger de ordenes.';

-- Misma regla que isDashboardPaidSale (lib/business/dashboard-financials.ts).
create or replace function public.analytics_is_confirmed_sale(
  p_estado text,
  p_payment_status text,
  p_financial_status text,
  p_paid_at timestamptz,
  p_payment_confirmed_amount numeric
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(p_payment_status, '') <> all (array[
      'approved_after_cancellation', 'approved_stock_conflict', 'approved_amount_mismatch',
      'approved_currency_mismatch', 'auto_verified_stock_conflict'])
    and (
      coalesce(p_estado, '') = any (array[
        'pagado', 'approved', 'enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
        'retiro_pendiente', 'retiro_vencido', 'en_devolucion', 'devuelto_beyonix', 'entregado'])
      or p_paid_at is not null
      or coalesce(p_payment_confirmed_amount, 0) > 0
      or coalesce(p_payment_status, '') = any (array['confirmado', 'approved', 'confirmed'])
      or coalesce(p_financial_status, '') = any (array['payment_confirmed', 'refund_pending', 'refunded'])
    );
$$;

revoke all on function public.analytics_is_confirmed_sale(text, text, text, timestamptz, numeric) from public, anon, authenticated;
grant execute on function public.analytics_is_confirmed_sale(text, text, text, timestamptz, numeric) to service_role;

create or replace function public.analytics_record_purchase()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.analytics_purchases (order_id, user_id, revenue, confirmed_at)
    values (
      new.id,
      new.usuario_id,
      greatest(coalesce(new.original_total, new.total, 0), 0),
      coalesce(new.payment_confirmed_at, new.paid_at, now())
    )
    on conflict (order_id) do nothing;
  exception when others then
    raise warning '[analytics] purchase_completed no registrada para la orden %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function public.analytics_record_purchase() from public, anon, authenticated;

drop trigger if exists analytics_record_purchase on public.ordenes;
create trigger analytics_record_purchase
  after insert or update of estado, payment_status, financial_status, paid_at, payment_confirmed_amount
  on public.ordenes
  for each row
  when (public.analytics_is_confirmed_sale(
    new.estado, new.payment_status, new.financial_status, new.paid_at, new.payment_confirmed_amount))
  execute function public.analytics_record_purchase();

commit;
