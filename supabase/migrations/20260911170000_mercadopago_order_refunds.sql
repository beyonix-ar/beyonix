-- FASE 1 del sistema seguro de refunds de Mercado Pago (auditoría 2026-09-11).
--
-- HALLAZGO P0 confirmado: no existía ninguna llamada real al refund de
-- Mercado Pago en todo el repositorio. "Reembolsar" un pedido -- pagado por
-- MP o por transferencia, sin distinción -- era subir un comprobante manual
-- (commit_order_refund_proof) que marca financial_status='refunded' sin
-- ninguna verificación de que el dinero salió por Mercado Pago.
--
-- Esta migración agrega:
-- 1. mercadopago_order_refunds: tabla dedicada para el ciclo de vida del
--    refund de MP (ver justificación de tabla dedicada vs. columnas en
--    `ordenes` en el comentario de la tabla, más abajo).
-- 2. begin_mercadopago_order_refund: reserva/reutiliza atómicamente el
--    intento de refund para un pedido (CAS vía `for update` + índices
--    parciales únicos -- dos admins simultáneos jamás generan dos refunds).
-- 3. record_mercadopago_order_refund_result: registra el resultado real
--    (confirmado/rechazado/ambiguo) -- sólo 'confirmed' toca
--    ordenes.financial_status. Nunca se marca 'refunded' sólo porque se
--    envió el POST.
-- 4. reconcile_mercadopago_order_refund: delega en la misma lógica que (3)
--    para resolver un intento 'processing'/'needs_reconciliation' contra el
--    estado real reconsultado a Mercado Pago -- nunca dispara un nuevo POST.
--
-- Esta migración es deliberadamente PREPARATORIA y 100% aditiva/backward-
-- compatible: sólo crea objetos nuevos (tabla + funciones), no modifica
-- ningún objeto preexistente. El comprobante manual (commit_order_refund_proof)
-- sigue funcionando sin cambios para TODOS los medios de pago, incluido
-- Mercado Pago, hasta que se aplique la migración de activación separada
-- 20260911190000_lock_manual_refund_proof_for_mercadopago.sql -- eso permite
-- desplegar esta migración + el código nuevo en producción sin dejar una
-- ventana en la que ningún flujo (ni el viejo ni el nuevo) pueda reembolsar
-- un pedido de Mercado Pago.

begin;

-- ============================================================
-- 1. Tabla dedicada
-- ============================================================
--
-- Por qué tabla dedicada y no columnas en `ordenes` (pedido explícito de la
-- tarea):
-- - Historial: un pedido puede tener más de un INTENTO (timeout, rechazo,
--   reintento posterior) antes de un refund confirmado -- columnas en
--   `ordenes` sólo pueden representar el último estado, perdiendo el rastro
--   de los intentos previos que son justamente la evidencia que se necesita
--   ante una disputa o auditoría.
-- - Idempotencia: la clave de idempotencia vive atada a UN intento
--   concreto, no al pedido -- si el pedido tuviera su propia columna
--   `idempotency_key`, un segundo intento legítimo (tras un rechazo
--   definitivo) no tendría dónde guardar una clave nueva sin pisar la
--   anterior.
-- - Reintentos/reconciliación: necesitan poder distinguir CUÁL intento
--   están resolviendo (CAS por fila, no por pedido) -- con columnas sueltas
--   en `ordenes` no hay noción de "intento" contra la cual hacer ese CAS.
-- - Refunds parciales futuros (Fase 2): un pedido podría necesitar más de
--   un refund confirmado a lo largo del tiempo (parcial + parcial) -- eso
--   es 1:N con `ordenes`, imposible de modelar en columnas sueltas sin
--   volver a esta misma tabla más adelante.
-- - Múltiples eventos de Mercado Pago: cada intento puede recibir más de
--   una señal (respuesta síncrona del POST + reconciliación posterior) sin
--   perder cuál fue cada una.
create table public.mercadopago_order_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null references public.ordenes(id),
  payment_id text not null,
  amount numeric(12, 2) not null check (amount > 0),
  -- Fase 1 sólo crea refunds totales (is_partial=false siempre). La columna
  -- existe desde ya para que un futuro refund parcial (P2 pendiente, ver
  -- Fase 2) no requiera romper la constraint de abajo -- ver esa constraint
  -- para el razonamiento completo.
  is_partial boolean not null default false,
  status text not null default 'processing'
    check (status in ('requested', 'processing', 'confirmed', 'failed', 'needs_reconciliation')),
  mp_refund_id text,
  idempotency_key text not null,
  requested_by uuid not null references auth.users(id),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  attempt_count integer not null default 1,
  -- Reservado para el job de reconciliación (Fase 2): evita que dos workers
  -- concurrentes reconcilien la misma fila (ver
  -- claim_mercadopago_refunds_for_reconciliation).
  reconciliation_locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.mercadopago_order_refunds is
  'Ciclo de vida de cada intento de refund real contra Mercado Pago para un pedido. Fuente de verdad del refund de MP -- ordenes.financial_status sólo refleja el resultado ya confirmado acá. Ver justificación de tabla dedicada en el comentario de la migración 20260911170000.';
comment on column public.mercadopago_order_refunds.status is
  'requested: fila creada, todavía no se intentó el POST contra MP. processing: el POST está/estuvo en curso -- resultado real desconocido hasta confirmar. confirmed/failed: terminales. needs_reconciliation: timeout o respuesta ambigua tras el POST -- requiere reconsultar a MP antes de cualquier otro intento.';
comment on column public.mercadopago_order_refunds.is_partial is
  'Siempre false en Fase 1 (sólo refund total). Reservado para Fase 2: un refund parcial futuro no debe competir con el índice único de "un solo refund total confirmado por pedido" de abajo.';

create unique index mercadopago_order_refunds_idempotency_key_idx
  on public.mercadopago_order_refunds (idempotency_key);

-- A lo sumo UN intento activo (no confirmado ni fallido) por pedido a la vez.
-- Esto es lo que impide que dos admins simultáneos generen dos refunds: el
-- segundo begin_mercadopago_order_refund encuentra esta fila y la reutiliza
-- en vez de crear una nueva.
create unique index mercadopago_order_refunds_active_per_order_idx
  on public.mercadopago_order_refunds (order_id)
  where status in ('requested', 'processing', 'needs_reconciliation');

-- A lo sumo UN refund TOTAL confirmado por pedido -- deliberadamente
-- acotado a `is_partial = false` (no a todo `status = 'confirmed'`) para
-- que un futuro conjunto de refunds PARCIALES confirmados (múltiples filas,
-- is_partial=true) no choque contra este índice. La invariante "nunca se
-- reembolsa más de lo que Mercado Pago capturó" para el caso parcial es
-- responsabilidad de la RPC que lo implemente en Fase 2 (debe sumar
-- refunds confirmados -- totales y parciales -- contra payment_confirmed_amount
-- antes de aceptar uno nuevo); esta tabla ya queda preparada para eso.
create unique index mercadopago_order_refunds_confirmed_full_per_order_idx
  on public.mercadopago_order_refunds (order_id)
  where status = 'confirmed' and is_partial = false;

create index mercadopago_order_refunds_order_idx
  on public.mercadopago_order_refunds (order_id, created_at desc);
create index mercadopago_order_refunds_payment_idx
  on public.mercadopago_order_refunds (payment_id);
create index mercadopago_order_refunds_reconciliation_queue_idx
  on public.mercadopago_order_refunds (updated_at asc)
  where status = 'needs_reconciliation';

alter table public.mercadopago_order_refunds enable row level security;
-- Sin policies: ni anon ni authenticated tienen ninguna vía de lectura ni
-- escritura directa. Sólo se accede vía las RPC de abajo (service_role).
revoke all on public.mercadopago_order_refunds from public, anon, authenticated;
grant select, insert, update on public.mercadopago_order_refunds to service_role;

create function public.touch_mercadopago_order_refunds_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger touch_mercadopago_order_refunds_updated_at
before update on public.mercadopago_order_refunds
for each row execute function public.touch_mercadopago_order_refunds_updated_at();

-- ============================================================
-- 2. begin_mercadopago_order_refund
-- ============================================================
-- Reserva o reutiliza atómicamente el intento de refund de un pedido.
-- NUNCA llama a Mercado Pago -- sólo decide, bajo lock, si corresponde
-- llamarlo y con qué datos (payment_id, monto exacto, idempotency_key).
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

-- ============================================================
-- 3. record_mercadopago_order_refund_result
-- ============================================================
-- Registra el resultado REAL de un intento. Sólo 'confirmed' toca
-- ordenes.financial_status -- nunca se marca 'refunded' por haber enviado
-- el POST. Se usa tanto para la respuesta síncrona del POST como (vía
-- reconcile_mercadopago_order_refund) para la reconciliación posterior.
create or replace function public.record_mercadopago_order_refund_result(
  p_refund_id uuid,
  p_outcome text,
  p_mp_refund_id text default null,
  p_error_code text default null,
  p_error_message text default null
)
returns public.mercadopago_order_refunds
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_row public.mercadopago_order_refunds%rowtype;
  v_order public.ordenes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  if p_outcome not in ('confirmed', 'failed', 'needs_reconciliation', 'requested') then
    raise exception 'INVALID_REFUND_OUTCOME';
  end if;

  select *
  into v_row
  from public.mercadopago_order_refunds
  where id = p_refund_id
  for update;

  if not found then
    raise exception 'REFUND_ATTEMPT_NOT_FOUND';
  end if;

  -- Idempotente: un resultado ya terminal no se sobreescribe. Reentregas
  -- del mismo resultado (p.ej. el caller reintenta guardar tras un error de
  -- red propio) son un no-op seguro.
  if v_row.status in ('confirmed', 'failed') then
    return v_row;
  end if;

  if v_row.status not in ('processing', 'needs_reconciliation') then
    raise exception 'REFUND_ATTEMPT_NOT_IN_PROGRESS';
  end if;

  -- 'requested' (volver a intentable) sólo se alcanza vía reconciliación,
  -- cuando Mercado Pago confirma que NUNCA recibió el refund -- válido
  -- tanto si la fila seguía 'processing' (se reconcilió antes de que el
  -- propio POST reportara timeout/ambigüedad) como si ya estaba
  -- 'needs_reconciliation'. La restricción real ya la impone
  -- reconcile_mercadopago_order_refund/el chequeo de arriba: sólo se llega
  -- acá desde 'processing' o 'needs_reconciliation', nunca desde
  -- 'requested' recién creada (ese caso no tiene resultado que registrar).

  update public.mercadopago_order_refunds
  set
    status = p_outcome,
    mp_refund_id = coalesce(p_mp_refund_id, mp_refund_id),
    error_code = case when p_outcome in ('failed', 'needs_reconciliation') then p_error_code else null end,
    error_message = case when p_outcome in ('failed', 'needs_reconciliation') then p_error_message else null end,
    completed_at = case when p_outcome in ('confirmed', 'failed') then now() else completed_at end
  where id = p_refund_id
  returning * into v_row;

  if p_outcome = 'confirmed' then
    select * into v_order from public.ordenes where id = v_row.order_id for update;

    update public.ordenes
    set
      financial_status = 'refunded',
      refund_method = 'mercadopago',
      refund_amount = v_row.amount,
      refunded_at = now(),
      refunded_by = v_row.requested_by
    where id = v_row.order_id;

    insert into public.order_audit_events (
      order_id, actor_type, actor_id, action, previous_status, new_status, metadata
    ) values (
      v_row.order_id, 'system', null, 'mercadopago_refund_confirmed',
      'refund_pending', 'refunded',
      jsonb_build_object(
        'refundAttemptId', v_row.id,
        'paymentId', v_row.payment_id,
        'mpRefundId', v_row.mp_refund_id,
        'amount', v_row.amount
      )
    );
  end if;

  return v_row;
end;
$function$;

revoke execute on function public.record_mercadopago_order_refund_result(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_mercadopago_order_refund_result(uuid, text, text, text, text)
  to service_role;

-- ============================================================
-- 4. reconcile_mercadopago_order_refund
-- ============================================================
-- Wrapper explícito sobre (3) para la reconciliación posterior: exige que
-- la fila esté en un estado que realmente necesite reconciliarse (fail
-- closed contra reconciliar una fila 'requested' recién creada, que ni
-- siquiera llegó a intentarse). Reutiliza la misma lógica de (3) a
-- propósito -- el efecto sobre ordenes/auditoría debe ser idéntico,
-- distinguir el origen (respuesta directa vs. reconciliación) es sólo para
-- trazabilidad, no una regla de negocio distinta.
create or replace function public.reconcile_mercadopago_order_refund(
  p_refund_id uuid,
  p_outcome text,
  p_mp_refund_id text default null,
  p_error_code text default null,
  p_error_message text default null
)
returns public.mercadopago_order_refunds
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
declare
  v_row public.mercadopago_order_refunds%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select * into v_row from public.mercadopago_order_refunds where id = p_refund_id for update;
  if not found then
    raise exception 'REFUND_ATTEMPT_NOT_FOUND';
  end if;

  -- Sólo se rechaza reconciliar una fila 'requested' recién creada (nunca
  -- se intentó, no hay nada que reconciliar contra Mercado Pago todavía).
  -- 'confirmed'/'failed' se dejan pasar a (3), que ya es idempotente para
  -- esos dos casos (reentregas de la reconciliación no fallan).
  if v_row.status = 'requested' then
    raise exception 'REFUND_ATTEMPT_NOT_STARTED';
  end if;

  return public.record_mercadopago_order_refund_result(
    p_refund_id, p_outcome, p_mp_refund_id, p_error_code, p_error_message
  );
end;
$function$;

revoke execute on function public.reconcile_mercadopago_order_refund(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_mercadopago_order_refund(uuid, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
