alter table public.ordenes
  add column if not exists original_total numeric(12, 2),
  add column if not exists credit_balance_used numeric(12, 2) not null default 0,
  add column if not exists external_amount_due numeric(12, 2),
  add column if not exists payment_composition jsonb not null default '{}'::jsonb,
  add column if not exists credit_balance_movement_id uuid;

update public.ordenes
set
  original_total = coalesce(original_total, total),
  external_amount_due = coalesce(external_amount_due, total)
where original_total is null
   or external_amount_due is null;

alter table public.ordenes
  drop constraint if exists ordenes_credit_balance_non_negative_check;

alter table public.ordenes
  add constraint ordenes_credit_balance_non_negative_check
  check (
    coalesce(original_total, 0) >= 0
    and coalesce(credit_balance_used, 0) >= 0
    and coalesce(external_amount_due, 0) >= 0
  );

alter table public.order_claims
  drop constraint if exists order_claims_resolution_check,
  add constraint order_claims_resolution_check check (
    resolution is null
    or resolution in (
      'cambio_producto',
      'envio_unidad_faltante',
      'reintegro_total',
      'reintegro_parcial',
      'saldo_a_favor',
      'cupon_descuento',
      'rechazado',
      'otro'
    )
  );

alter table public.order_claims
  drop constraint if exists order_claims_offered_resolutions_check,
  add constraint order_claims_offered_resolutions_check check (
    offered_resolutions <@ array[
      'cambio_producto',
      'envio_unidad_faltante',
      'reintegro_total',
      'reintegro_parcial',
      'saldo_a_favor',
      'cupon_descuento',
      'otro'
    ]::text[]
  );

alter table public.order_claims
  drop constraint if exists order_claims_customer_selected_resolution_check,
  add constraint order_claims_customer_selected_resolution_check check (
    customer_selected_resolution is null
    or customer_selected_resolution in (
      'cambio_producto',
      'envio_unidad_faltante',
      'reintegro_total',
      'reintegro_parcial',
      'saldo_a_favor',
      'cupon_descuento',
      'otro'
    )
  );

create table if not exists public.customer_credit_movements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  movement_type text not null,
  amount numeric(12, 2) not null,
  description text not null,
  source_type text not null,
  source_id text,
  order_id bigint references public.ordenes(id) on delete set null,
  claim_id bigint references public.order_claims(id) on delete set null,
  credit_note_id text,
  created_by uuid references auth.users(id) on delete set null,
  related_movement_id uuid references public.customer_credit_movements(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  source_key text,
  resulting_balance numeric(12, 2),
  constraint customer_credit_movements_type_check check (
    movement_type in ('credit', 'debit', 'reversal', 'adjustment', 'expiration')
  ),
  constraint customer_credit_movements_source_type_check check (
    source_type in (
      'credit_note',
      'claim',
      'return',
      'exchange',
      'order',
      'admin_adjustment',
      'reversal'
    )
  ),
  constraint customer_credit_movements_amount_check check (amount > 0),
  constraint customer_credit_movements_description_check check (
    length(trim(description)) between 3 and 500
  )
);

create unique index if not exists customer_credit_movements_source_key_idx
  on public.customer_credit_movements (source_key)
  where source_key is not null;

create index if not exists customer_credit_movements_user_created_idx
  on public.customer_credit_movements (user_id, created_at desc);

create index if not exists customer_credit_movements_order_idx
  on public.customer_credit_movements (order_id);

create index if not exists customer_credit_movements_source_idx
  on public.customer_credit_movements (source_type, source_id);

create index if not exists customer_credit_movements_claim_idx
  on public.customer_credit_movements (claim_id);

alter table public.ordenes
  drop constraint if exists ordenes_credit_balance_movement_id_fkey;

alter table public.ordenes
  add constraint ordenes_credit_balance_movement_id_fkey
  foreign key (credit_balance_movement_id)
  references public.customer_credit_movements(id)
  on delete set null;

alter table public.customer_credit_movements enable row level security;

drop policy if exists "Customers can read own credit movements"
  on public.customer_credit_movements;
create policy "Customers can read own credit movements"
on public.customer_credit_movements
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Internal users can read credit movements"
  on public.customer_credit_movements;
create policy "Internal users can read credit movements"
on public.customer_credit_movements
for select
to authenticated
using (public.current_user_role() in ('admin', 'super_admin'));

revoke all on public.customer_credit_movements from anon, authenticated;
grant select on public.customer_credit_movements to authenticated;

create or replace function public.customer_credit_movement_effect(
  p_movement_type text
)
returns integer
language sql
immutable
as $$
  select case
    when p_movement_type in ('credit', 'reversal', 'adjustment') then 1
    when p_movement_type in ('debit', 'expiration') then -1
    else 0
  end;
$$;

create or replace function public.get_customer_credit_balance(
  p_user_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance numeric(12, 2);
begin
  if p_user_id is null then
    raise exception 'USER_REQUIRED';
  end if;

  if auth.role() <> 'service_role'
     and auth.uid() is distinct from p_user_id
     and public.current_user_role() not in ('admin', 'super_admin') then
    raise exception 'No tenés permisos para consultar este saldo.';
  end if;

  select coalesce(
    sum(
      amount * public.customer_credit_movement_effect(movement_type)
    ) filter (
      where movement_type in ('debit', 'expiration')
         or expires_at is null
         or expires_at > now()
    ),
    0
  )
  into v_balance
  from public.customer_credit_movements
  where user_id = p_user_id;

  return greatest(coalesce(v_balance, 0), 0);
end;
$$;

revoke all on function public.get_customer_credit_balance(uuid) from public;
grant execute on function public.get_customer_credit_balance(uuid)
  to authenticated, service_role;

create or replace function public.create_customer_credit_movement(
  p_user_id uuid,
  p_movement_type text,
  p_amount numeric,
  p_description text,
  p_source_type text default 'admin_adjustment',
  p_source_id text default null,
  p_order_id bigint default null,
  p_claim_id bigint default null,
  p_credit_note_id text default null,
  p_created_by uuid default null,
  p_related_movement_id uuid default null,
  p_expires_at timestamptz default null,
  p_metadata jsonb default '{}'::jsonb,
  p_source_key text default null
)
returns table (
  movement_id uuid,
  resulting_balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric(12, 2);
  v_balance numeric(12, 2);
  v_effect integer;
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
begin
  if auth.role() <> 'service_role'
     and public.current_user_role() not in ('admin', 'super_admin') then
    raise exception 'No tenés permisos para crear movimientos de saldo.';
  end if;

  v_amount := round(coalesce(p_amount, 0)::numeric, 2);
  v_effect := public.customer_credit_movement_effect(p_movement_type);
  v_source_key := nullif(trim(coalesce(p_source_key, '')), '');

  if p_user_id is null or v_amount <= 0 or v_effect = 0 then
    raise exception 'INVALID_CUSTOMER_CREDIT_MOVEMENT';
  end if;

  if p_movement_type not in ('credit', 'debit', 'reversal', 'adjustment', 'expiration') then
    raise exception 'INVALID_CUSTOMER_CREDIT_MOVEMENT_TYPE';
  end if;

  if p_source_type not in (
    'credit_note',
    'claim',
    'return',
    'exchange',
    'order',
    'admin_adjustment',
    'reversal'
  ) then
    raise exception 'INVALID_CUSTOMER_CREDIT_SOURCE_TYPE';
  end if;

  if length(trim(coalesce(p_description, ''))) < 3 then
    raise exception 'CUSTOMER_CREDIT_DESCRIPTION_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer-credit:' || p_user_id::text));

  if v_source_key is not null then
    select *
    into v_existing
    from public.customer_credit_movements
    where source_key = v_source_key
    limit 1;

    if found then
      movement_id := v_existing.id;
      resulting_balance := coalesce(
        v_existing.resulting_balance,
        public.get_customer_credit_balance(p_user_id)
      );
      return next;
      return;
    end if;
  end if;

  select public.get_customer_credit_balance(p_user_id)
  into v_balance;

  if v_effect < 0 and v_amount > v_balance then
    raise exception 'INSUFFICIENT_CUSTOMER_CREDIT';
  end if;

  insert into public.customer_credit_movements (
    user_id,
    movement_type,
    amount,
    description,
    source_type,
    source_id,
    order_id,
    claim_id,
    credit_note_id,
    created_by,
    related_movement_id,
    expires_at,
    metadata,
    source_key,
    resulting_balance
  ) values (
    p_user_id,
    p_movement_type,
    v_amount,
    trim(p_description),
    p_source_type,
    p_source_id,
    p_order_id,
    p_claim_id,
    p_credit_note_id,
    coalesce(p_created_by, auth.uid()),
    p_related_movement_id,
    p_expires_at,
    coalesce(p_metadata, '{}'::jsonb),
    v_source_key,
    greatest(v_balance + (v_amount * v_effect), 0)
  )
  returning *
  into v_movement;

  movement_id := v_movement.id;
  resulting_balance := coalesce(v_movement.resulting_balance, 0);
  return next;
end;
$$;

revoke all on function public.create_customer_credit_movement(
  uuid,
  text,
  numeric,
  text,
  text,
  text,
  bigint,
  bigint,
  text,
  uuid,
  uuid,
  timestamptz,
  jsonb,
  text
) from public;
grant execute on function public.create_customer_credit_movement(
  uuid,
  text,
  numeric,
  text,
  text,
  text,
  bigint,
  bigint,
  text,
  uuid,
  uuid,
  timestamptz,
  jsonb,
  text
) to service_role;

create or replace function public.apply_customer_credit_to_order(
  p_user_id uuid,
  p_order_id bigint,
  p_amount numeric,
  p_description text default 'Saldo a favor aplicado a compra',
  p_source_key text default null
)
returns table (
  movement_id uuid,
  remaining_balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_balance numeric(12, 2);
  v_amount numeric(12, 2);
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
begin
  if auth.role() <> 'service_role'
     and public.current_user_role() not in ('admin', 'super_admin') then
    raise exception 'No tenés permisos para aplicar saldo.';
  end if;

  v_amount := round(coalesce(p_amount, 0)::numeric, 2);

  if p_user_id is null or p_order_id is null or v_amount <= 0 then
    raise exception 'INVALID_CREDIT_APPLICATION';
  end if;

  perform pg_advisory_xact_lock(hashtext('customer-credit:' || p_user_id::text));

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if v_order.usuario_id is distinct from p_user_id then
    raise exception 'ORDER_USER_MISMATCH';
  end if;

  if coalesce(v_order.credit_balance_used, 0) > 0
     or v_order.credit_balance_movement_id is not null then
    raise exception 'ORDER_CREDIT_ALREADY_APPLIED';
  end if;

  v_source_key := coalesce(
    nullif(trim(p_source_key), ''),
    'order:' || p_order_id || ':customer-credit:debit'
  );

  select *
  into v_existing
  from public.customer_credit_movements
  where source_key = v_source_key
  limit 1;

  if found then
    raise exception 'CUSTOMER_CREDIT_DEBIT_ALREADY_EXISTS';
  end if;

  select public.get_customer_credit_balance(p_user_id)
  into v_balance;

  if v_amount > v_balance then
    raise exception 'INSUFFICIENT_CUSTOMER_CREDIT';
  end if;

  if v_amount > coalesce(v_order.original_total, v_order.total, 0) then
    raise exception 'CUSTOMER_CREDIT_EXCEEDS_ORDER_TOTAL';
  end if;

  insert into public.customer_credit_movements (
    user_id,
    movement_type,
    amount,
    description,
    source_type,
    source_id,
    order_id,
    created_by,
    source_key,
    resulting_balance,
    metadata
  ) values (
    p_user_id,
    'debit',
    v_amount,
    coalesce(nullif(trim(p_description), ''), 'Saldo a favor aplicado a compra'),
    'order',
    p_order_id::text,
    p_order_id,
    auth.uid(),
    v_source_key,
    v_balance - v_amount,
    jsonb_build_object(
      'order_id', p_order_id,
      'original_total', coalesce(v_order.original_total, v_order.total, 0)
    )
  )
  returning *
  into v_movement;

  update public.ordenes
  set
    credit_balance_used = v_amount,
    external_amount_due = greatest(
      coalesce(original_total, total, 0) - v_amount,
      0
    ),
    credit_balance_movement_id = v_movement.id,
    payment_composition = coalesce(payment_composition, '{}'::jsonb) ||
      jsonb_build_object(
        'credit_balance_used', v_amount,
        'external_amount_due', greatest(coalesce(original_total, total, 0) - v_amount, 0),
        'credit_movement_id', v_movement.id
      )
  where id = p_order_id;

  movement_id := v_movement.id;
  remaining_balance := v_balance - v_amount;
  return next;
end;
$$;

revoke all on function public.apply_customer_credit_to_order(uuid, bigint, numeric, text, text)
  from public;
grant execute on function public.apply_customer_credit_to_order(uuid, bigint, numeric, text, text)
  to service_role;

create or replace function public.reverse_customer_credit_for_order(
  p_order_id bigint,
  p_description text default 'Reintegro de saldo a favor por cancelación',
  p_created_by uuid default null
)
returns table (
  movement_id uuid,
  restored_amount numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_amount numeric(12, 2);
  v_balance numeric(12, 2);
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
begin
  if auth.role() <> 'service_role'
     and public.current_user_role() not in ('admin', 'super_admin') then
    raise exception 'No tenés permisos para revertir saldo.';
  end if;

  if p_order_id is null then
    raise exception 'ORDER_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtext('order-credit-reversal:' || p_order_id::text));

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  v_amount := round(coalesce(v_order.credit_balance_used, 0)::numeric, 2);

  if v_order.usuario_id is null or v_amount <= 0 then
    movement_id := null;
    restored_amount := 0;
    return next;
    return;
  end if;

  v_source_key := 'order:' || p_order_id || ':customer-credit:reversal';

  select *
  into v_existing
  from public.customer_credit_movements
  where source_key = v_source_key
  limit 1;

  if found then
    movement_id := v_existing.id;
    restored_amount := v_existing.amount;
    return next;
    return;
  end if;

  select public.get_customer_credit_balance(v_order.usuario_id)
  into v_balance;

  insert into public.customer_credit_movements (
    user_id,
    movement_type,
    amount,
    description,
    source_type,
    source_id,
    order_id,
    created_by,
    related_movement_id,
    source_key,
    resulting_balance,
    metadata
  ) values (
    v_order.usuario_id,
    'reversal',
    v_amount,
    coalesce(nullif(trim(p_description), ''), 'Reintegro de saldo a favor por cancelación'),
    'reversal',
    p_order_id::text,
    p_order_id,
    p_created_by,
    v_order.credit_balance_movement_id,
    v_source_key,
    v_balance + v_amount,
    jsonb_build_object(
      'order_id', p_order_id,
      'reversed_movement_id', v_order.credit_balance_movement_id
    )
  )
  returning *
  into v_movement;

  movement_id := v_movement.id;
  restored_amount := v_movement.amount;
  return next;
end;
$$;

revoke all on function public.reverse_customer_credit_for_order(bigint, text, uuid)
  from public;
grant execute on function public.reverse_customer_credit_for_order(bigint, text, uuid)
  to service_role;

create or replace function public.notify_customer_credit_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_body text;
  v_amount text;
begin
  if new.user_id is null then
    return new;
  end if;

  v_amount := to_char(new.amount, 'FM$999G999G999G990');

  if new.movement_type = 'debit' then
    v_title := 'Saldo a favor usado';
    v_body := 'Usaste ' || v_amount || ' de tu saldo a favor' ||
      case when new.order_id is not null then ' en el pedido BX-' || (1000 + new.order_id)::text else '' end || '.';
  elsif new.movement_type = 'reversal' then
    v_title := 'Saldo a favor reintegrado';
    v_body := 'Se devolvieron ' || v_amount || ' a tu saldo a favor.';
  else
    v_title := 'Saldo a favor acreditado';
    v_body := 'Se acreditaron ' || v_amount || ' en tu saldo a favor.';
  end if;

  insert into public.customer_notifications (
    user_id,
    type,
    title,
    body,
    action_url,
    order_id,
    source_key
  ) values (
    new.user_id,
    'customer_credit',
    v_title,
    v_body,
    '/cuenta?tab=saldo',
    new.order_id,
    'customer-credit:' || new.id::text
  )
  on conflict (source_key) do nothing;

  return new;
end;
$$;

drop trigger if exists notify_customer_credit_movement_trigger
  on public.customer_credit_movements;
create trigger notify_customer_credit_movement_trigger
after insert
on public.customer_credit_movements
for each row
execute function public.notify_customer_credit_movement();
