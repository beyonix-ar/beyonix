-- Future Andreani tariff responses only. Existing orders have no response to backfill.
create table public.andreani_quote_snapshots (
  id bigint generated always as identity primary key,
  quoted_at timestamptz not null default now(),
  source text not null check (source in ('checkout', 'measured')),
  order_id bigint references public.ordenes(id) on delete set null,
  environment text not null check (environment in ('QA', 'PROD')),
  contract text not null,
  client_code text not null,
  origin_branch text,
  destination_postal_code text not null,
  packages jsonb not null check (jsonb_typeof(packages) = 'array' and jsonb_array_length(packages) > 0),
  amount_without_vat numeric(12,2) not null check (amount_without_vat > 0),
  amount_with_vat numeric(12,2) not null check (amount_with_vat > 0),
  distribution_without_vat numeric(12,2) not null check (distribution_without_vat >= 0),
  distribution_with_vat numeric(12,2) not null check (distribution_with_vat >= 0),
  insurance_without_vat numeric(12,2) not null check (insurance_without_vat >= 0),
  insurance_with_vat numeric(12,2) not null check (insurance_with_vat >= 0),
  response jsonb not null check (jsonb_typeof(response) = 'object')
);

create index andreani_quote_snapshots_order_idx on public.andreani_quote_snapshots(order_id, quoted_at desc)
  where order_id is not null;
create index andreani_quote_snapshots_quoted_at_idx on public.andreani_quote_snapshots(quoted_at desc);

alter table public.andreani_quote_snapshots enable row level security;
revoke all on public.andreani_quote_snapshots from public, anon, authenticated;
grant select, insert on public.andreani_quote_snapshots to service_role;
grant usage on sequence public.andreani_quote_snapshots_id_seq to service_role;

-- Actual customer payment above the Andreani checkout quote; internal markup remains unchanged.
create or replace function public.admin_logistics_summary(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, pg_temp as $$
  with orders as (
    select o.*,
      (o.estado in ('pagado','approved','enviado','en_camino','visita_fallida','en_sucursal',
        'retiro_pendiente','retiro_vencido','en_devolucion','devuelto_beyonix','entregado')
       or o.payment_status = 'approved') and o.estado <> 'cancelado' as sold
    from public.ordenes o
    where o.created_at >= p_from and o.created_at < p_to
      and coalesce(o.shipping_provider, o.envio_proveedor) = 'andreani'
  ),
  current_parcels as (
    select pk.order_id, count(p.id)::integer as parcels
    from public.order_packages pk
    join public.order_package_parcels p on p.package_id = pk.id
      and p.attempt_number = pk.attempt_number and p.parcel_count = pk.parcel_count
    where pk.order_id in (select id from orders) and pk.parcel_count is not null
    group by pk.order_id
  ),
  reconciliation as (
    select r.* from public.andreani_order_reconciliation(
      array(select id from orders where sold)) r
  )
  select jsonb_build_object(
    'ordersCreated', count(*) filter (where o.andreani_envio_id is not null),
    'ordersSent', count(*) filter (where o.andreani_handed_over_at is not null
      or o.estado in ('enviado','en_camino','visita_fallida','en_sucursal','retiro_pendiente',
        'retiro_vencido','en_devolucion','devuelto_beyonix','entregado')),
    'ordersDelivered', count(*) filter (where o.estado = 'entregado' or o.delivered_at is not null),
    'ordersReturned', count(*) filter (where o.estado in ('en_devolucion','devuelto_beyonix')
      or exists (select 1 from public.order_claims c where c.order_id = o.id and c.cancelled_at is null)),
    'parcels', coalesce(sum(cp.parcels), 0),
    'soldOrders', count(*) filter (where o.sold),
    'snapshotOrders', count(*) filter (where o.sold and o.shipping_provider_quote_amount is not null),
    'chargedToCustomers', coalesce(sum(o.shipping_cost_charged) filter (where o.sold), 0),
    'providerQuoted', coalesce(sum(o.shipping_provider_quote_amount) filter (where o.sold), 0),
    'markupCollected', coalesce(sum(greatest(o.shipping_cost_charged - o.shipping_provider_quote_amount, 0)) filter (where o.sold and o.shipping_cost_charged is not null and o.shipping_provider_quote_amount is not null), 0),
    'roundingAdjustment', coalesce(sum(o.shipping_rounding_amount) filter (where o.sold), 0),
    'benefitAbsorbed', coalesce(sum(coalesce(o.shipping_benefit_amount,
      greatest(coalesce(o.shipping_cost_real, 0) - coalesce(o.shipping_cost_charged, 0), 0)))
      filter (where o.sold), 0),
    'parcelQuoted', coalesce(sum(o.shipping_parcel_quote_amount) filter (where o.sold
      and o.shipping_parcel_quote_status = 'quoted'), 0),
    'parcelQuotedOrders', count(*) filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'),
    'parcelQuoteDifference', coalesce(sum(o.shipping_parcel_quote_amount - o.shipping_provider_quote_amount)
      filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'
        and o.shipping_provider_quote_amount is not null), 0),
    'parcelQuoteComparableOrders', count(*) filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'
      and o.shipping_provider_quote_amount is not null),
    'comparableProviderQuoted', coalesce(sum(o.shipping_provider_quote_amount)
      filter (where o.sold and o.shipping_parcel_quote_status = 'quoted'
        and o.shipping_provider_quote_amount is not null), 0),
    'billedByAndreani', coalesce((select sum(r.billed_total) from reconciliation r), 0),
    'billedOutbound', coalesce((select sum(r.billed_outbound) from reconciliation r), 0),
    'billedReturnsAndExchanges', coalesce((select sum(coalesce(r.billed_return, 0) + coalesce(r.billed_exchange, 0)
      + coalesce(r.billed_other, 0)) from reconciliation r), 0),
    'billedOrders', (select count(*) from reconciliation r where r.entries > 0),
    'billedDifferenceVsCheckout', coalesce((select sum(r.difference_checkout) from reconciliation r), 0),
    'billedDifferenceVsCheckoutOrders', (select count(*) from reconciliation r where r.difference_checkout is not null),
    'billedDifferenceVsParcel', coalesce((select sum(r.difference_parcel) from reconciliation r), 0),
    'billedDifferenceVsParcelOrders', (select count(*) from reconciliation r where r.difference_parcel is not null),
    'reconciledOrders', (select count(*) from reconciliation r where r.status = 'reconciled'),
    'minorDifferenceOrders', (select count(*) from reconciliation r where r.status = 'minor_difference'),
    'majorDifferenceOrders', (select count(*) from reconciliation r where r.status = 'major_difference'),
    'noReferenceOrders', (select count(*) from reconciliation r where r.status = 'no_reference'),
    'pendingReconciliationOrders', (select count(*) from reconciliation r where r.status = 'pending'),
    'unmatchedEntries', (select count(*) from public.andreani_billing_entries e
      where e.match_status = 'unmatched'
        and e.billed_on >= (p_from at time zone 'America/Argentina/Buenos_Aires')::date
        and e.billed_on < (p_to at time zone 'America/Argentina/Buenos_Aires')::date),
    'unmatchedAmount', coalesce((select sum(e.billed_amount) from public.andreani_billing_entries e
      where e.match_status = 'unmatched'
        and e.billed_on >= (p_from at time zone 'America/Argentina/Buenos_Aires')::date
        and e.billed_on < (p_to at time zone 'America/Argentina/Buenos_Aires')::date), 0),
    'thresholds', public.andreani_reconciliation_thresholds()
  )
  from orders o
  left join current_parcels cp on cp.order_id = o.id
$$;
