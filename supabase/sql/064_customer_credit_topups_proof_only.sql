alter table public.customer_credit_topups
  alter column amount drop not null,
  alter column customer_name drop not null,
  alter column customer_dni drop not null;

alter table public.customer_credit_topups
  drop constraint if exists customer_credit_topups_amount_check,
  drop constraint if exists customer_credit_topups_customer_name_check,
  drop constraint if exists customer_credit_topups_customer_dni_check;

alter table public.customer_credit_topups
  add constraint customer_credit_topups_amount_check
    check (amount is null or amount > 0),
  add constraint customer_credit_topups_customer_name_check
    check (
      customer_name is null
      or length(trim(customer_name)) between 3 and 120
    ),
  add constraint customer_credit_topups_customer_dni_check
    check (
      customer_dni is null
      or customer_dni ~ '^[0-9]{7,8}$'
    );

create index if not exists customer_credit_topups_status_created_idx
  on public.customer_credit_topups (status, created_at desc);

comment on column public.customer_credit_topups.amount is
  'Monto verificado e ingresado por administración al acreditar el comprobante.';

comment on column public.customer_credit_topups.customer_name is
  'Campo histórico. La identidad actual se obtiene desde user_id.';

comment on column public.customer_credit_topups.customer_dni is
  'Campo histórico. La identidad actual se obtiene desde user_id.';

create or replace function public.resolve_customer_credit_topup(
  p_topup_id uuid,
  p_action text,
  p_amount numeric default null,
  p_admin_notes text default null,
  p_resolved_by uuid default null
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
  v_amount numeric(12, 2);
  v_movement_id uuid;
  v_resulting_balance numeric(12, 2);
begin
  if auth.role() <> 'service_role'
     and public.current_user_role() not in ('admin', 'super_admin') then
    raise exception 'No tenés permisos para resolver cargas de saldo.';
  end if;

  if p_action not in ('approve', 'reject') then
    raise exception 'INVALID_TOPUP_ACTION';
  end if;

  select *
  into v_topup
  from public.customer_credit_topups
  where id = p_topup_id
  for update;

  if not found then
    raise exception 'TOPUP_NOT_FOUND';
  end if;

  if v_topup.status <> 'en_revision' then
    raise exception 'TOPUP_ALREADY_RESOLVED';
  end if;

  if p_action = 'reject' then
    update public.customer_credit_topups
    set
      status = 'rechazado',
      admin_notes = coalesce(
        nullif(trim(coalesce(p_admin_notes, '')), ''),
        'Transferencia no recibida o comprobante inválido.'
      ),
      updated_at = now()
    where id = v_topup.id;

    topup_status := 'rechazado';
    movement_id := null;
    resulting_balance := public.get_customer_credit_balance(v_topup.user_id);
    return next;
    return;
  end if;

  v_amount := round(coalesce(p_amount, 0)::numeric, 2);

  if v_amount <= 0 then
    raise exception 'INVALID_TOPUP_AMOUNT';
  end if;

  select created.movement_id, created.resulting_balance
  into v_movement_id, v_resulting_balance
  from public.create_customer_credit_movement(
    p_user_id => v_topup.user_id,
    p_movement_type => 'credit',
    p_amount => v_amount,
    p_description => 'Carga de saldo por transferencia acreditada',
    p_source_type => 'admin_adjustment',
    p_source_id => v_topup.id::text,
    p_created_by => coalesce(p_resolved_by, auth.uid()),
    p_metadata => jsonb_build_object(
      'created_from', 'customer_credit_topup',
      'source_kind', 'balance_topup',
      'topup_id', v_topup.id
    ),
    p_source_key => 'customer-credit-topup:' || v_topup.id::text
  ) as created;

  update public.customer_credit_topups
  set
    amount = v_amount,
    status = 'acreditado',
    credited_movement_id = v_movement_id,
    admin_notes = nullif(trim(coalesce(p_admin_notes, '')), ''),
    updated_at = now()
  where id = v_topup.id;

  topup_status := 'acreditado';
  movement_id := v_movement_id;
  resulting_balance := v_resulting_balance;
  return next;
end;
$$;

revoke all on function public.resolve_customer_credit_topup(uuid, text, numeric, text, uuid)
  from public;
grant execute on function public.resolve_customer_credit_topup(uuid, text, numeric, text, uuid)
  to authenticated, service_role;
