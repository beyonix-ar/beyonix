-- P0: cierra el acceso anónimo y las guardas NULL/fail-open del saldo.
-- Definiciones verificadas con pg_get_functiondef en remoto el 2026-09-11.
-- Sólo cambia autorización y search_path; conserva firmas, defaults, retornos,
-- locks, idempotencia, cálculos y escrituras de las implementaciones vigentes.
--
-- Consumidores auditados:
-- Las cuatro RPC base sólo se invocan desde lib/customer-credit/server.ts
-- (server-only), con createAdminClient() / service_role:
-- checkout por saldo, transferencia y Mercado Pago; consulta de saldo y
-- movimientos; ajustes admin; notas de crédito; webhook; vencimiento y
-- cancelación de órdenes. requireInternalUser valida la sesión y el perfil
-- admin/super_admin antes de entregar ese cliente; no necesita EXECUTE con
-- la sesión authenticated del navegador.
-- resolve_customer_credit_topup: app/api/admin/clientes/saldos/route.ts.
-- credit_customer_credit_topup_from_mercadopago:
-- lib/mercadopago/customer-credit-topups.ts (webhook y conciliación backend).
-- Ambas son SECURITY DEFINER y llaman a las RPC base: también se cierran.
-- approve_order_claim_cancellation y
-- request_customer_order_cancellation_with_claim ya tienen EXECUTE restringido
-- a service_role; las llamadas anidadas conservan auth.role() del request.
-- No hay consumidores directos en navegador ni vistas/políticas que invoquen
-- estas cuatro RPC en el catálogo inspeccionado.
--
-- No usar current_user como autorización: en SECURITY DEFINER sería el dueño.
-- No exigir auth.uid(): service_role legítimo puede tener uid/perfil NULL.
-- El dueño postgres conserva sus privilegios; su invocación sin contexto JWT
-- service_role se rechaza deliberadamente, igual que cualquier rol NULL.

begin;

CREATE OR REPLACE FUNCTION public.get_customer_credit_balance(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_balance numeric(12, 2);
begin
  if p_user_id is null then
    raise exception 'USER_REQUIRED';
  end if;

  if auth.role() is distinct from 'service_role' then
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
$function$;

CREATE OR REPLACE FUNCTION public.create_customer_credit_movement(p_user_id uuid, p_movement_type text, p_amount numeric, p_description text, p_source_type text DEFAULT 'admin_adjustment'::text, p_source_id text DEFAULT NULL::text, p_order_id bigint DEFAULT NULL::bigint, p_claim_id bigint DEFAULT NULL::bigint, p_credit_note_id text DEFAULT NULL::text, p_created_by uuid DEFAULT NULL::uuid, p_related_movement_id uuid DEFAULT NULL::uuid, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_metadata jsonb DEFAULT '{}'::jsonb, p_source_key text DEFAULT NULL::text)
 RETURNS TABLE(movement_id uuid, resulting_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_amount numeric(12, 2);
  v_balance numeric(12, 2);
  v_effect integer;
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
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
$function$;

CREATE OR REPLACE FUNCTION public.apply_customer_credit_to_order(p_user_id uuid, p_order_id bigint, p_amount numeric, p_description text DEFAULT 'Saldo a favor aplicado a compra'::text, p_source_key text DEFAULT NULL::text)
 RETURNS TABLE(movement_id uuid, remaining_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_order public.ordenes%rowtype;
  v_balance numeric(12, 2);
  v_amount numeric(12, 2);
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
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
$function$;

CREATE OR REPLACE FUNCTION public.reverse_customer_credit_for_order(p_order_id bigint, p_description text DEFAULT 'Reintegro de saldo a favor por cancelación'::text, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(movement_id uuid, restored_amount numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_order public.ordenes%rowtype;
  v_amount numeric(12, 2);
  v_balance numeric(12, 2);
  v_source_key text;
  v_existing public.customer_credit_movements%rowtype;
  v_movement public.customer_credit_movements%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
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
$function$;

CREATE OR REPLACE FUNCTION public.resolve_customer_credit_topup(p_topup_id uuid, p_action text, p_amount numeric DEFAULT NULL::numeric, p_admin_notes text DEFAULT NULL::text, p_resolved_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(topup_status text, movement_id uuid, resulting_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_topup public.customer_credit_topups%rowtype;
  v_amount numeric(12, 2);
  v_movement_id uuid;
  v_resulting_balance numeric(12, 2);
begin
  if auth.role() is distinct from 'service_role' then
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

CREATE OR REPLACE FUNCTION public.credit_customer_credit_topup_from_mercadopago(p_topup_id uuid, p_payment_id text, p_payment_status text, p_paid_amount numeric)
 RETURNS TABLE(topup_status text, movement_id uuid, resulting_balance numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_topup public.customer_credit_topups%rowtype;
  v_paid_amount numeric(12, 2);
  v_movement_id uuid;
  v_resulting_balance numeric(12, 2);
begin
  if auth.role() is distinct from 'service_role' then
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

revoke execute on function public.get_customer_credit_balance(uuid)
  from public, anon, authenticated;
grant execute on function public.get_customer_credit_balance(uuid)
  to service_role;

revoke execute on function public.create_customer_credit_movement(uuid,text,numeric,text,text,text,bigint,bigint,text,uuid,uuid,timestamp with time zone,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.create_customer_credit_movement(uuid,text,numeric,text,text,text,bigint,bigint,text,uuid,uuid,timestamp with time zone,jsonb,text)
  to service_role;

revoke execute on function public.apply_customer_credit_to_order(uuid,bigint,numeric,text,text)
  from public, anon, authenticated;
grant execute on function public.apply_customer_credit_to_order(uuid,bigint,numeric,text,text)
  to service_role;

revoke execute on function public.reverse_customer_credit_for_order(bigint,text,uuid)
  from public, anon, authenticated;
grant execute on function public.reverse_customer_credit_for_order(bigint,text,uuid)
  to service_role;

revoke execute on function public.resolve_customer_credit_topup(uuid,text,numeric,text,uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_customer_credit_topup(uuid,text,numeric,text,uuid)
  to service_role;

revoke execute on function public.credit_customer_credit_topup_from_mercadopago(uuid,text,text,numeric)
  from public, anon, authenticated;
grant execute on function public.credit_customer_credit_topup_from_mercadopago(uuid,text,text,numeric)
  to service_role;

notify pgrst, 'reload schema';

commit;

