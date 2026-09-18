-- FASE 4 (cierre del módulo cancelaciones/reintegros/NC). Dos huecos
-- confirmados en la auditoría anterior:
--
-- 1) TRANSFERENCIA PAGADA, NUNCA FACTURADA, CANCELADA (credit_note_required
--    = false desde el origen: nunca hubo Factura C, así que fiscalmente no
--    corresponde ninguna NC). commit_order_refund_proof exigía
--    incondicionalmente una nota de crédito autorizada con CAE para
--    determinar el importe -- sin NC, `v_amount` siempre daba 0 y la
--    función nunca podía completarse. No existía ningún camino backend
--    para registrar este reintegro (auditado y confirmado, no era un
--    supuesto). Se extiende la MISMA función (no una nueva, para no
--    duplicar CAS/validación de archivo/auditoría/notificación) con una
--    rama alternativa, activa únicamente cuando el pedido nunca requirió
--    NC (`credit_note_required = false` Y ninguna nota de crédito con
--    destino que mueva dinero existe para ese pedido): el importe se
--    calcula con la MISMA fórmula REFUNDABLE_EXTERNAL_AMOUNT ya corregida
--    en Fase 1 (20260917120000_credit_note_refundable_external_cap.sql),
--    nunca un monto nuevo. La rama con NC requerida queda BYTE A BYTE
--    igual a la vigente.
--
-- 2) REFERENCIA BANCARIA / FECHA / OBSERVACIÓN del reintegro: hoy sólo se
--    persiste el comprobante. Se agregan dos columnas nuevas a
--    order_refund_proofs (`bank_reference`, `refund_date` -- `observation`
--    ya existía pero no se usaba) y se cablean en el INSERT + en
--    order_audit_events, para ambas ramas (con y sin NC).
--
-- 3) ASIMETRÍA MERCADO PAGO vs. TRANSFERENCIA: begin_mercadopago_order_refund
--    podía ejecutar un refund real sin verificar credit_note_required, pese
--    a que un pedido facturado (por cualquier medio de pago) fiscalmente
--    necesita una NC para cancelar/reducir esa factura -- misma exigencia
--    que ya aplica a transferencia (commit_order_refund_proof). No es una
--    regla fiscal nueva: es la MISMA que ya rige para transferencia,
--    aplicada de forma consistente. En el flujo normal (UI) esto nunca se
--    dispara -- getCancellationNextAction jamás ofrece "execute_mp_refund"
--    mientras credit_note_required siga true, siempre muestra primero
--    "emit_credit_note" -- así que este guard es defensa en profundidad
--    (no depender sólo de la UI), no un cambio de comportamiento visible.

begin;

alter table public.order_refund_proofs
  add column if not exists bank_reference text,
  add column if not exists refund_date date;

create or replace function public.commit_order_refund_proof(p_operation_id uuid, p_actor_id uuid, p_file jsonb)
returns public.ordenes
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_op public.order_claim_operations%rowtype;
  v_order public.ordenes%rowtype;
  v_amount numeric;
  v_notes uuid[];
  v_proof_id bigint;
  v_role text;
  v_path text := p_file->>'path';
  v_reference text := nullif(trim(coalesce(p_file->>'reference', '')), '');
  v_refund_date date := nullif(p_file->>'refund_date', '')::date;
  v_observation text := nullif(trim(coalesce(p_file->>'notes', '')), '');
  v_no_credit_note_path boolean := false;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id=p_actor_id;
  if coalesce(v_role,'') not in ('admin','super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  if length(coalesce(v_reference, '')) > 120 or length(coalesce(v_observation, '')) > 600 then
    raise exception 'INVALID_REFUND_DETAILS';
  end if;
  select * into v_op from public.order_claim_operations where id=p_operation_id and actor_id=p_actor_id for update;
  if not found then raise exception 'CLAIM_FORBIDDEN'; end if;
  select * into v_order from public.ordenes where id=v_op.order_id for update;
  if v_order.payment_method_id = 'mercadopago' then
    raise exception 'MERCADOPAGO_REQUIRES_REAL_REFUND';
  end if;
  if v_op.status='committed' then return v_order; end if;
  if v_op.status<>'uploading' or v_op.expires_at<=now() or v_op.bucket_id<>'payment-proofs' then raise exception 'CLAIM_CONFLICT'; end if;
  if v_order.financial_status='cancelled' then raise exception 'CLAIM_CONFLICT'; end if;

  -- NUEVO (Fase 4, punto 1): sin NC requerida y sin ninguna NC que mueva
  -- dinero ya emitida para este pedido -- reintegro directo contra el
  -- dinero externo confirmado. Nunca se activa para un pedido que sí
  -- necesita NC (credit_note_required=true cae siempre a la rama de abajo,
  -- sin cambios).
  if not coalesce(v_order.credit_note_required, false)
     and not exists(
       select 1 from public.order_credit_notes
       where order_id = v_order.id and destination <> 'none'
     ) then
    v_no_credit_note_path := true;

    -- Idempotencia: sólo puede completarse una vez por pedido -- tras la
    -- primera ejecución financial_status pasa a 'refunded' y cualquier
    -- reintento cae acá (mismo código de error que ya usa la rama con NC
    -- cuando no queda nada pendiente de liquidar).
    if v_order.financial_status <> 'refund_pending' then
      raise exception 'CLAIM_REFUND_PENDING';
    end if;

    -- Misma fórmula REFUNDABLE_EXTERNAL_AMOUNT que
    -- 20260917120000_credit_note_refundable_external_cap.sql: dinero
    -- externo confirmado, nunca el total (que podría incluir saldo ya
    -- restaurado aparte por reverse_customer_credit_for_order).
    v_amount := greatest(
      coalesce(
        nullif(v_order.payment_confirmed_amount, 0),
        v_order.external_amount_due,
        greatest(coalesce(v_order.original_total, v_order.total, 0) - coalesce(v_order.credit_balance_used, 0), 0),
        0
      ),
      0
    );
    if coalesce(v_amount, 0) <= 0 then raise exception 'CLAIM_REFUND_PENDING'; end if;
  else
    perform id from public.order_credit_notes where order_id=v_order.id order by id for update;
    select sum(total_amount),array_agg(id order by id) into v_amount,v_notes from public.order_credit_notes
      where order_id=v_order.id and status='authorized' and destination='external_refund' and settlement_status is distinct from 'completado' and cae is not null;
    if coalesce(v_amount,0)<=0 then raise exception 'CLAIM_REFUND_PENDING'; end if;
    if jsonb_typeof(p_file->'expected_note_ids') is distinct from 'array' or
      v_notes is distinct from (select array_agg(value::uuid order by value::uuid) from jsonb_array_elements_text(p_file->'expected_note_ids')) then raise exception 'CLAIM_CONFLICT'; end if;
    if exists(select 1 from public.order_credit_notes where order_id=v_order.id and status='processing') then raise exception 'CLAIM_CONFLICT'; end if;
  end if;

  if not(v_path=any(v_op.file_paths)) or not exists(select 1 from storage.objects where bucket_id='payment-proofs' and name=v_path) then raise exception 'CLAIM_INVALID_FILES'; end if;
  insert into public.order_refund_proofs(order_id,uploaded_by,file_name,file_path,mime_type,file_size,amount,method,observation,bank_reference,refund_date)
    values(v_order.id,p_actor_id,p_file->>'name','payment-proofs/'||v_path,p_file->>'type',(p_file->>'size')::bigint,v_amount,'Devolución de dinero',v_observation,v_reference,coalesce(v_refund_date, current_date))
    returning id into v_proof_id;
  if not v_no_credit_note_path then
    update public.order_credit_notes set management_status='finalizada',settlement_status='completado',settlement_date=current_date,settlement_reference=v_proof_id::text,updated_at=now() where id=any(v_notes);
  end if;
  insert into public.order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values(v_order.id,'admin',p_actor_id,'order_refunded',v_order.financial_status,'refunded',jsonb_build_object('proofId',v_proof_id,'amount',v_amount,'creditNoteIds',v_notes,'reference',v_reference,'refundDate',v_refund_date,'requiredCreditNote', not v_no_credit_note_path));
  update public.ordenes set financial_status='refunded',refund_proof_url='payment-proofs/'||v_path,refund_proof_file_name=p_file->>'name',refund_proof_mime_type=p_file->>'type',refund_proof_file_size=(p_file->>'size')::bigint,
    refund_amount=(select sum(amount) from public.order_refund_proofs where order_id=v_order.id),refund_method='Devolución de dinero',refund_uploaded_by=p_actor_id,refund_uploaded_at=now(),refunded_at=now(),refunded_by=p_actor_id,credit_note_required=false where id=v_order.id returning * into v_order;
  if v_order.usuario_id is not null then
    insert into public.customer_notifications(user_id,type,title,body,action_url,order_id,source_key)
      values(v_order.usuario_id,'order_refunded','Dinero reintegrado','Registramos el reintegro de tu pedido.','/cuenta/compras/'||v_order.id,v_order.id,'order:'||v_order.id||':refunded') on conflict(source_key) do nothing;
  end if;
  update public.order_claim_operations set status='committed' where id=v_op.id;
  return v_order;
end $$;

revoke all on function public.commit_order_refund_proof(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.commit_order_refund_proof(uuid,uuid,jsonb) to service_role;

comment on function public.commit_order_refund_proof(uuid,uuid,jsonb) is
  'Registra el comprobante y cierra el reintegro externo (transferencia). Si el pedido nunca requirió NC (nunca se facturó), calcula el importe con la fórmula REFUNDABLE_EXTERNAL_AMOUNT (payment_confirmed_amount) en vez de sumar notas de crédito. Persiste referencia bancaria, fecha y observación. Fix 20260917130000.';

-- Punto 3: política de NC para Mercado Pago -- misma exigencia fiscal que
-- ya aplica a transferencia, defensa en profundidad (la UI ya secuencia
-- NC antes de refund MP; esto lo hace explícito e inquebrantable server-side).
create or replace function public.begin_mercadopago_order_refund(
  p_order_id bigint,
  p_admin_id uuid
)
returns table (
  refund_id uuid,
  payment_id text,
  amount numeric,
  idempotency_key text,
  status text,
  should_call_mp boolean,
  mp_refund_id text
)
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_order public.ordenes%rowtype;
  v_existing public.mercadopago_order_refunds%rowtype;
  v_row public.mercadopago_order_refunds%rowtype;
  v_role text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  if p_order_id is null or p_admin_id is null then
    raise exception 'INVALID_REFUND_REQUEST';
  end if;

  select rol into v_role from public.profiles where id = p_admin_id;
  if coalesce(v_role, '') not in ('admin', 'super_admin') then
    raise exception 'REFUND_FORBIDDEN';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- Se busca cualquier intento existente ANTES de exigir las precondiciones
  -- de "orden elegible para un refund nuevo" -- un refund ya confirmado (o
  -- en curso) es siempre un no-op idempotente, incluso si para entonces
  -- ordenes.financial_status ya cambió a 'refunded' y por lo tanto ya NO
  -- pasaría el chequeo de 'refund_pending' de más abajo.
  select *
  into v_existing
  from public.mercadopago_order_refunds
  where order_id = p_order_id
  order by created_at desc
  limit 1
  for update;

  if found and v_existing.status = 'confirmed' then
    refund_id := v_existing.id;
    payment_id := v_existing.payment_id;
    amount := v_existing.amount;
    idempotency_key := v_existing.idempotency_key;
    status := v_existing.status;
    should_call_mp := false;
    mp_refund_id := v_existing.mp_refund_id;
    return next;
    return;
  end if;

  if found and v_existing.status in ('processing', 'needs_reconciliation') then
    -- Ya hay un intento en curso o ambiguo: nunca se dispara un segundo
    -- POST. El llamador debe reconciliar, no reintentar a ciegas.
    refund_id := v_existing.id;
    payment_id := v_existing.payment_id;
    amount := v_existing.amount;
    idempotency_key := v_existing.idempotency_key;
    status := v_existing.status;
    should_call_mp := false;
    mp_refund_id := v_existing.mp_refund_id;
    return next;
    return;
  end if;

  -- A partir de acá se va a crear o reclamar un intento NUEVO (no existe
  -- ninguno confirmado/en curso): recién ahora se exigen las precondiciones
  -- completas de "orden elegible para un refund".
  if v_order.payment_method_id is distinct from 'mercadopago' then
    raise exception 'ORDER_NOT_PAID_BY_MERCADOPAGO';
  end if;

  if nullif(trim(coalesce(v_order.payment_id, '')), '') is null then
    raise exception 'ORDER_MISSING_MERCADOPAGO_PAYMENT_ID';
  end if;

  if coalesce(v_order.payment_confirmed_amount, 0) <= 0 then
    raise exception 'ORDER_MISSING_CONFIRMED_AMOUNT';
  end if;

  if v_order.financial_status is distinct from 'refund_pending' then
    raise exception 'ORDER_NOT_REFUND_PENDING';
  end if;

  -- NUEVO (punto 3): un pedido facturado necesita NC antes de reintegrar,
  -- sin importar el medio de pago -- misma exigencia que ya aplica a
  -- transferencia (commit_order_refund_proof). credit_note_required ya es
  -- false para pedidos que nunca se facturaron, así que esto nunca bloquea
  -- ese caso.
  if v_order.credit_note_required then
    raise exception 'CREDIT_NOTE_REQUIRED';
  end if;

  -- Defensa en profundidad: approve_order_claim_cancellation ya bloquea
  -- aprobar una cancelación sobre un pedido despachado, pero un refund
  -- puede ejecutarse en un momento posterior a esa aprobación -- se
  -- vuelve a chequear acá con las mismas reglas.
  if lower(coalesce(v_order.estado, '')) in (
       'enviado', 'en_camino', 'visita_fallida', 'en_sucursal',
       'retiro_pendiente', 'retiro_vencido', 'en_devolucion',
       'devuelto_beyonix', 'entregado'
     )
     or nullif(trim(v_order.tracking_number), '') is not null
     or nullif(trim(v_order.andreani_tracking), '') is not null
     or nullif(trim(v_order.andreani_envio_id), '') is not null then
    raise exception 'ORDER_ALREADY_DISPATCHED';
  end if;

  if found and v_existing.status = 'requested' then
    -- Fila creada pero el POST nunca se confirmó como enviado (crash entre
    -- el commit de esta función y la llamada HTTP): se reclama la MISMA
    -- fila, con la MISMA idempotency_key -- nunca una nueva.
    update public.mercadopago_order_refunds
    set status = 'processing', attempt_count = attempt_count + 1
    where id = v_existing.id
    returning * into v_row;
  else
    -- Ninguna fila activa (nunca hubo intento, o el último terminó en
    -- 'failed' -- un rechazo definitivo previo SÍ admite un intento nuevo,
    -- con una idempotency_key propia).
    insert into public.mercadopago_order_refunds (
      order_id, payment_id, amount, status, idempotency_key, requested_by
    ) values (
      p_order_id, v_order.payment_id, v_order.payment_confirmed_amount,
      'processing', 'mercadopago-order-refund:' || gen_random_uuid()::text, p_admin_id
    )
    returning * into v_row;
  end if;

  refund_id := v_row.id;
  payment_id := v_row.payment_id;
  amount := v_row.amount;
  idempotency_key := v_row.idempotency_key;
  status := v_row.status;
  should_call_mp := true;
  mp_refund_id := v_row.mp_refund_id;
  return next;
end;
$function$;

revoke execute on function public.begin_mercadopago_order_refund(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_mercadopago_order_refund(bigint, uuid)
  to service_role;

comment on function public.begin_mercadopago_order_refund(bigint, uuid) is
  'Reclama atómicamente un intento de refund real contra Mercado Pago, idempotente por pedido (nunca dos intentos activos, nunca dos POST). Fix 20260917130000: exige credit_note_required=false (misma política fiscal que ya aplica a transferencia) antes de permitir el refund -- defensa en profundidad, la UI ya secuencia NC antes que esto.';

notify pgrst, 'reload schema';

commit;
