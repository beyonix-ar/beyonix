-- BACKFILL DE REGISTRO: `customer_credit_topups` y las funciones
-- `credit_customer_credit_topup_from_mercadopago` / `resolve_customer_credit_topup`
-- existen y están operativas en la base real (usadas por
-- lib/mercadopago/customer-credit-topups.ts y el webhook de Mercado Pago) pero
-- nunca quedaron representadas como migración -- se originaron en
-- supabase/sql/062_customer_credit_topups.sql y siguientes (062-078), que son
-- archivo histórico/manual y NUNCA se aplican automáticamente (ver
-- supabase/sql/README.md). Sin esto, `supabase/migrations` no reproduce el
-- esquema real y un ambiente nuevo (o un reset) no podría recrear la carga de
-- saldo por transferencia ni por Mercado Pago.
--
-- Esta migración reconstruye EXACTAMENTE el estado verificado contra la base
-- real (columnas, constraints, índices, RLS, políticas, grants, funciones,
-- SECURITY DEFINER/search_path y membresía en supabase_realtime) mediante
-- introspección directa (information_schema / pg_catalog) el 2026-09-06. No
-- cambia comportamiento: es un no-op en la base donde ya existe (CREATE TABLE
-- IF NOT EXISTS con todos los constraints inline, CREATE OR REPLACE FUNCTION
-- idéntica, grants repetibles) y sólo crea los objetos donde falten (ambiente
-- nuevo / reset local).

begin;

create table if not exists public.customer_credit_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(12, 2),
  customer_name text,
  customer_dni text,
  proof_url text,
  proof_file_name text,
  status text not null default 'en_revision',
  credited_movement_id uuid references public.customer_credit_movements(id) on delete set null,
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  payment_method text not null default 'transfer',
  gross_amount numeric(12, 2),
  surcharge_percent numeric(5, 2) not null default 0,
  surcharge_amount numeric(12, 2) not null default 0,
  mercadopago_preference_id text,
  mercadopago_payment_id text,
  mercadopago_status text,
  external_reference text,
  request_fingerprint text,
  constraint customer_credit_topups_amount_check
    check (amount is null or amount > 0),
  constraint customer_credit_topups_customer_dni_check
    check (customer_dni is null or customer_dni ~ '^[0-9]{7,8}$'),
  constraint customer_credit_topups_customer_name_check
    check (
      customer_name is null
      or (length(trim(customer_name)) >= 3 and length(trim(customer_name)) <= 120)
    ),
  constraint customer_credit_topups_gross_amount_check
    check (gross_amount is null or gross_amount > 0),
  constraint customer_credit_topups_payment_method_check
    check (payment_method = any (array['transfer', 'mercadopago'])),
  constraint customer_credit_topups_status_check
    check (
      status = any (
        array['pendiente_pago', 'en_revision', 'acreditado', 'rechazado', 'cancelado']
      )
    ),
  constraint customer_credit_topups_surcharge_amount_check
    check (surcharge_amount >= 0),
  constraint customer_credit_topups_surcharge_percent_check
    check (surcharge_percent >= 0 and surcharge_percent <= 100)
);

create index if not exists customer_credit_topups_external_reference_idx
  on public.customer_credit_topups using btree (external_reference)
  where (external_reference is not null);

create index if not exists customer_credit_topups_mp_fingerprint_created_idx
  on public.customer_credit_topups using btree (request_fingerprint, created_at desc)
  where (payment_method = 'mercadopago' and request_fingerprint is not null);

create unique index if not exists customer_credit_topups_mp_payment_unique_idx
  on public.customer_credit_topups using btree (mercadopago_payment_id)
  where (mercadopago_payment_id is not null);

create index if not exists customer_credit_topups_mp_user_created_idx
  on public.customer_credit_topups using btree (user_id, created_at desc)
  where (payment_method = 'mercadopago');

create unique index if not exists customer_credit_topups_one_active_mp_idx
  on public.customer_credit_topups using btree (user_id)
  where (payment_method = 'mercadopago' and status = 'pendiente_pago');

create index if not exists customer_credit_topups_status_created_idx
  on public.customer_credit_topups using btree (status, created_at desc);

create index if not exists customer_credit_topups_user_created_idx
  on public.customer_credit_topups using btree (user_id, created_at desc);

alter table public.customer_credit_topups enable row level security;

drop policy if exists "Admins can manage credit topups" on public.customer_credit_topups;
create policy "Admins can manage credit topups"
  on public.customer_credit_topups
  as permissive
  for all
  to authenticated
  using (current_user_role() = any (array['admin', 'super_admin']))
  with check (current_user_role() = any (array['admin', 'super_admin']));

drop policy if exists "Customers can read own credit topups" on public.customer_credit_topups;
create policy "Customers can read own credit topups"
  on public.customer_credit_topups
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

grant select, insert, update, delete on public.customer_credit_topups to authenticated;
grant select, insert, update, delete, references, trigger, truncate
  on public.customer_credit_topups to postgres, service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_rel pr
    join pg_publication p on p.oid = pr.prpubid
    join pg_class c on c.oid = pr.prrelid
    where p.pubname = 'supabase_realtime' and c.relname = 'customer_credit_topups'
  ) then
    alter publication supabase_realtime add table public.customer_credit_topups;
  end if;
end $$;

create or replace function public.credit_customer_credit_topup_from_mercadopago(
  p_topup_id uuid,
  p_payment_id text,
  p_payment_status text,
  p_paid_amount numeric
)
returns table(topup_status text, movement_id uuid, resulting_balance numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;

create or replace function public.resolve_customer_credit_topup(
  p_topup_id uuid,
  p_action text,
  p_amount numeric default null::numeric,
  p_admin_notes text default null::text,
  p_resolved_by uuid default null::uuid
)
returns table(topup_status text, movement_id uuid, resulting_balance numeric)
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;

grant execute on function public.credit_customer_credit_topup_from_mercadopago(uuid, text, text, numeric)
  to anon, authenticated, service_role, postgres;

grant execute on function public.resolve_customer_credit_topup(uuid, text, numeric, text, uuid)
  to anon, authenticated, service_role, postgres;

notify pgrst, 'reload schema';

commit;
