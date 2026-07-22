insert into public.site_settings (key, value, description)
values (
  'customer_credit_payments',
  '{"mercadoPagoSurchargePercent":8,"mercadoPagoMinimumAmount":10000}'::jsonb,
  'Configuración de medios de pago para cargas de saldo.'
)
on conflict (key) do nothing;

alter table public.customer_credit_topups
  add column if not exists payment_method text not null default 'transfer',
  add column if not exists gross_amount numeric(12, 2),
  add column if not exists surcharge_percent numeric(5, 2) not null default 0,
  add column if not exists surcharge_amount numeric(12, 2) not null default 0,
  add column if not exists mercadopago_preference_id text,
  add column if not exists mercadopago_payment_id text,
  add column if not exists mercadopago_status text,
  add column if not exists external_reference text;

alter table public.customer_credit_topups
  drop constraint if exists customer_credit_topups_status_check,
  drop constraint if exists customer_credit_topups_payment_method_check,
  drop constraint if exists customer_credit_topups_surcharge_percent_check,
  drop constraint if exists customer_credit_topups_surcharge_amount_check,
  drop constraint if exists customer_credit_topups_gross_amount_check;

alter table public.customer_credit_topups
  add constraint customer_credit_topups_status_check
    check (status in (
      'pendiente_pago',
      'en_revision',
      'acreditado',
      'rechazado',
      'cancelado'
    )),
  add constraint customer_credit_topups_payment_method_check
    check (payment_method in ('transfer', 'mercadopago')),
  add constraint customer_credit_topups_surcharge_percent_check
    check (surcharge_percent between 0 and 100),
  add constraint customer_credit_topups_surcharge_amount_check
    check (surcharge_amount >= 0),
  add constraint customer_credit_topups_gross_amount_check
    check (gross_amount is null or gross_amount > 0);

create unique index if not exists customer_credit_topups_mp_payment_unique_idx
  on public.customer_credit_topups (mercadopago_payment_id)
  where mercadopago_payment_id is not null;

create index if not exists customer_credit_topups_external_reference_idx
  on public.customer_credit_topups (external_reference)
  where external_reference is not null;

comment on column public.customer_credit_topups.amount is
  'Saldo neto que se acredita al cliente. En transferencias se completa al validar el comprobante.';

comment on column public.customer_credit_topups.gross_amount is
  'Total cobrado por el proveedor, incluido el costo de procesamiento cuando corresponde.';

create or replace function public.credit_customer_credit_topup_from_mercadopago(
  p_topup_id uuid,
  p_payment_id text,
  p_payment_status text,
  p_paid_amount numeric
)
returns table (
  topup_status text,
  movement_id uuid,
  resulting_balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup public.customer_credit_topups%rowtype;
  v_paid_amount numeric(12, 2);
  v_movement_id uuid;
  v_resulting_balance numeric(12, 2);
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select *
  into v_topup
  from public.customer_credit_topups
  where id = p_topup_id
  for update;

  if not found then
    raise exception 'TOPUP_NOT_FOUND';
  end if;

  if v_topup.payment_method <> 'mercadopago' then
    raise exception 'INVALID_TOPUP_PAYMENT_METHOD';
  end if;

  if p_payment_status <> 'approved' then
    raise exception 'PAYMENT_NOT_APPROVED';
  end if;

  if nullif(trim(coalesce(p_payment_id, '')), '') is null then
    raise exception 'PAYMENT_ID_REQUIRED';
  end if;

  if v_topup.status = 'acreditado' then
    if v_topup.mercadopago_payment_id is distinct from p_payment_id then
      raise exception 'TOPUP_ALREADY_CREDITED_BY_DIFFERENT_PAYMENT';
    end if;

    topup_status := v_topup.status;
    movement_id := v_topup.credited_movement_id;
    resulting_balance := public.get_customer_credit_balance(v_topup.user_id);
    return next;
    return;
  end if;

  v_paid_amount := round(coalesce(p_paid_amount, 0)::numeric, 2);

  if v_topup.amount is null
     or v_topup.gross_amount is null
     or abs(v_paid_amount - v_topup.gross_amount) > 0.01 then
    raise exception 'PAYMENT_AMOUNT_MISMATCH';
  end if;

  select created.movement_id, created.resulting_balance
  into v_movement_id, v_resulting_balance
  from public.create_customer_credit_movement(
    p_user_id => v_topup.user_id,
    p_movement_type => 'credit',
    p_amount => v_topup.amount,
    p_description => 'Carga de saldo acreditada automáticamente por Mercado Pago',
    p_source_type => 'admin_adjustment',
    p_source_id => v_topup.id::text,
    p_created_by => null,
    p_metadata => jsonb_build_object(
      'created_from', 'mercadopago_webhook',
      'source_kind', 'balance_topup',
      'topup_id', v_topup.id,
      'mercadopago_payment_id', p_payment_id,
      'gross_amount', v_topup.gross_amount,
      'surcharge_percent', v_topup.surcharge_percent,
      'surcharge_amount', v_topup.surcharge_amount
    ),
    p_source_key => 'customer-credit-topup-mp:' || v_topup.id::text
  ) as created;

  update public.customer_credit_topups
  set
    status = 'acreditado',
    credited_movement_id = v_movement_id,
    mercadopago_payment_id = p_payment_id,
    mercadopago_status = p_payment_status,
    updated_at = now()
  where id = v_topup.id;

  topup_status := 'acreditado';
  movement_id := v_movement_id;
  resulting_balance := v_resulting_balance;
  return next;
end;
$$;

revoke all on function public.credit_customer_credit_topup_from_mercadopago(
  uuid,
  text,
  text,
  numeric
) from public;
grant execute on function public.credit_customer_credit_topup_from_mercadopago(
  uuid,
  text,
  text,
  numeric
) to service_role;
