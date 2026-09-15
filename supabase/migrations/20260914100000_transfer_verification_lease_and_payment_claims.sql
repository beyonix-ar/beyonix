-- Corrige los bloqueantes detectados en la segunda y tercera auditoría de
-- Codex sobre la conciliación automática de transferencias (cda0d38..dcd4fb0
-- y la auditoría posterior sobre este mismo archivo, que todavía NO estaba
-- aplicado remotamente al momento de este commit -- ver comentario final):
--
-- 1) INTENTO VIEJO PUEDE CONFIRMAR DESPUÉS DE PERDER SU LEASE: el único
--    mecanismo anti-concurrencia era el lease temporal "checking" de
--    claim_transfer_verification_attempt (p_stale_checking_seconds, 60s por
--    defecto). Como una sola búsqueda contra Mercado Pago podía tardar mucho
--    más que eso (ver lib/mercadopago/bank-transfer-search.ts), un intento A
--    podía perder su lease por expiración, un intento B reclamar el mismo
--    pedido y confirmar, y el intento A -- que seguía vivo, sin saber que ya
--    no era el vigente -- terminar de correr y confirmar/liberar igual,
--    pisando el resultado de B. Se agrega un identificador único por intento
--    (fencing token): transfer_verification_lease_id, generado en cada claim
--    exitoso.
--
--    LA PRIMERA VERSIÓN de este chequeo (auditoría anterior) sólo comparaba
--    "transfer_verification_lease_id IS DISTINCT FROM p_lease_id" -- en
--    Postgres, NULL IS NOT DISTINCT FROM NULL, así que esa comparación
--    dejaba pasar exactamente los casos más peligrosos: p_lease_id NULL, o
--    un pedido que JAMÁS pasó por claim_transfer_verification_attempt (fila
--    con lease NULL). Tampoco validaba que transfer_verification_status
--    siguiera siendo 'checking' ni que el lease no hubiera quedado vencido
--    por tiempo. confirm_transfer_auto_verification ahora exige, bajo el
--    mismo FOR UPDATE, las cinco condiciones completas (ver más abajo,
--    LEASE_MISSING / LEASE_MISMATCH / LEASE_EXPIRED /
--    INVALID_VERIFICATION_STATE) antes de tocar cualquier estado de la
--    orden.
--
-- 2) UN payment.id LIBERADO PUEDE REUTILIZARSE: la única protección de
--    unicidad era el índice único parcial sobre el VALOR ACTUAL de
--    ordenes.transfer_matched_payment_id. Si una orden reclamaba el
--    payment.id A (ej.: conflicto de stock), un admin la rechazaba, el
--    cliente subía un comprobante nuevo y la orden terminaba confirmándose
--    con un payment.id B distinto, la columna se sobrescribía A -> B y el
--    payment.id A quedaba libre para que CUALQUIER OTRA orden lo reclamara.
--    Se agrega una tabla de claims históricos, insert-only, con clave
--    primaria sobre payment_id: una vez insertado un claim para un
--    payment.id, ese payment.id queda atado para siempre a esa orden,
--    exista o no todavía en la columna transfer_matched_payment_id de la
--    fila (que puede seguir cambiando con el tiempo). Nunca se borran ni se
--    reutilizan filas de esta tabla.
--
--    BUG DE UPGRADE (tercera auditoría): la tabla nueva se crea VACÍA. Ya
--    existen en producción órdenes con transfer_matched_payment_id
--    reservado por confirm_transfer_auto_verification desde
--    20260914090000/20260913120000 -- sin backfill, esos payment.id
--    quedarían "libres" según la nueva fuente de verdad (la tabla de
--    claims), exactamente el mismo bug que esta migración viene a cerrar.
--    Se agrega backfill de TODOS los transfer_matched_payment_id existentes
--    ANTES de dejar operativas las funciones nuevas, con una verificación
--    previa de conflictos históricos que aborta la migración entera
--    (transacción completa) si alguna vez encuentra el mismo payment.id en
--    más de una orden -- nunca elige una en silencio.
--
-- 3) LA COMPROBACIÓN DE VIGENCIA DEL LEASE USABA now() (QUINTA AUDITORÍA):
--    now() devuelve el timestamp de INICIO de la transacción y queda
--    congelado durante toda su ejecución -- incluida cualquier espera real
--    para adquirir el "for update". Codex reprodujo: lease con 59s de
--    antigüedad al arrancar la transacción, la transacción tarda/espera 2s
--    más antes de evaluar la vigencia, la antigüedad REAL ya es 61s
--    (vencida), pero now() seguía viendo 59s y la RPC confirmaba igual. Se
--    agrega v_lease_checked_at, asignado con clock_timestamp() (tiempo real
--    de pared) INMEDIATAMENTE DESPUÉS del "for update", usado ÚNICAMENTE
--    para la comprobación de vigencia del lease -- v_now (basado en now())
--    se sigue usando sin cambios para todo lo demás (payment_confirmed_at,
--    paid_at, transfer_last_verification_at al escribir, etc.), donde
--    congelar el inicio de transacción es el criterio correcto.
--
-- No reemplaza ninguna migración aplicada: 20260913120000 y 20260914090000
-- siguen aplicadas tal cual. Esta migración es aditiva (columna nueva, tabla
-- nueva, backfill) salvo por confirm_transfer_auto_verification, que cambia
-- de firma (agrega p_lease_id) -- por eso se hace DROP + CREATE explícito en
-- vez de CREATE OR REPLACE (que con una firma distinta crearía un overload
-- nuevo en lugar de reemplazar la función existente).
--
-- IMPORTANTE: verificado con `supabase migration list` antes de escribir
-- este archivo (y de nuevo antes de esta revisión) que 20260914100000 sigue
-- SIN aplicar remotamente ("remote":"" en la salida del comando) -- por eso
-- se sigue pudiendo modificar este mismo archivo en vez de crear una
-- migración incremental.

begin;

alter table public.ordenes
  add column if not exists transfer_verification_lease_id uuid;

comment on column public.ordenes.transfer_verification_lease_id is
  'Identificador único (fencing token) del intento de verificación automática vigente. Se genera en cada claim_transfer_verification_attempt exitoso. confirm_transfer_auto_verification sólo puede confirmar/reclamar si coincide EXACTAMENTE con el vigente en la fila, la fila sigue en transfer_verification_status=checking y el lease no venció por tiempo -- un intento viejo (sin lease, con lease NULL, con lease reemplazado o vencido) nunca puede completar una confirmación.';

-- Historial insert-only de payment.id de Mercado Pago ya utilizados por
-- alguna orden. Fuente de verdad de unicidad INDEPENDIENTE del valor actual
-- de ordenes.transfer_matched_payment_id (que puede sobrescribirse con el
-- tiempo si la misma orden termina usando otro payment.id distinto).
create table if not exists public.transfer_verification_payment_claims (
  payment_id text primary key,
  order_id bigint not null references public.ordenes(id),
  claimed_at timestamptz not null default now()
);

create index if not exists transfer_verification_payment_claims_order_id_idx
  on public.transfer_verification_payment_claims (order_id);

alter table public.transfer_verification_payment_claims enable row level security;
revoke all on public.transfer_verification_payment_claims from public, anon, authenticated;
-- Sólo lectura/inserción: nunca se actualiza ni se borra un claim ya escrito.
grant select, insert on public.transfer_verification_payment_claims to service_role;

comment on table public.transfer_verification_payment_claims is
  'Claims históricos, insert-only, de payment.id de Mercado Pago ya reclamados por una orden de transferencia. Una vez insertado un payment_id acá, esa asociación con order_id es permanente: aunque la orden luego cambie de estado o reclame un payment.id distinto, este payment.id nunca puede volver a usarse por otra orden. Nunca se actualiza ni se borra.';

-- BACKFILL (tercera auditoría): antes de dejar operativa la nueva fuente de
-- verdad de unicidad, migrar TODO lo que ya estaba reservado por el
-- mecanismo anterior (el valor actual de ordenes.transfer_matched_payment_id).
--
-- Verificación de conflictos históricos PRIMERO: el índice único parcial
-- ordenes_transfer_matched_payment_id_key (20260913120000) ya debería
-- garantizar que un mismo payment.id nunca está en más de una fila de
-- ordenes al mismo tiempo -- pero nunca hay que asumirlo en silencio ante un
-- backfill irreversible. Si alguna vez apareciera más de una orden con el
-- mismo transfer_matched_payment_id (dato inconsistente / índice dañado /
-- restaurado sin el índice), esta migración aborta COMPLETA (toda la
-- transacción, incluida la creación de la tabla de arriba) en vez de elegir
-- una orden en silencio -- requiere resolución manual antes de reintentar.
do $$
declare
  v_conflict record;
begin
  select transfer_matched_payment_id, count(*) as cnt
  into v_conflict
  from public.ordenes
  where transfer_matched_payment_id is not null
  group by transfer_matched_payment_id
  having count(*) > 1
  limit 1;

  if found then
    raise exception
      'TRANSFER_PAYMENT_ID_HISTORICAL_CONFLICT: el payment.id % está reservado por % pedidos distintos (se esperaba a lo sumo 1). Backfill abortado: requiere resolución manual antes de aplicar esta migración.',
      v_conflict.transfer_matched_payment_id, v_conflict.cnt;
  end if;
end $$;

-- claimed_at usa el mejor timestamp histórico disponible (cuándo se verificó
-- por última vez esa orden), nunca el momento de aplicar la migración, para
-- no inventar un historial falso. on conflict do nothing: idempotente ante
-- una reaplicación manual de este archivo antes de que llegue a aplicarse
-- remotamente (nunca sobreescribe un claim ya insertado).
insert into public.transfer_verification_payment_claims (payment_id, order_id, claimed_at)
select
  o.transfer_matched_payment_id,
  o.id,
  coalesce(o.transfer_last_verification_at, o.created_at, now())
from public.ordenes o
where o.transfer_matched_payment_id is not null
on conflict (payment_id) do nothing;

-- claim_transfer_verification_attempt: genera y persiste un lease nuevo en
-- cada claim exitoso (mismos chequeos que 20260913120000, misma firma --
-- CREATE OR REPLACE es seguro acá).
create or replace function public.claim_transfer_verification_attempt(
  p_order_id bigint,
  p_max_attempts integer default 20,
  p_min_interval_seconds integer default 5,
  p_stale_checking_seconds integer default 60
)
returns public.ordenes
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := now();
  v_lease_id uuid := gen_random_uuid();
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND: no encontramos el pedido.';
  end if;

  if v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'NOT_TRANSFER_ORDER: este pedido no corresponde a transferencia bancaria.';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'ORDER_CANCELLED: el pedido está cancelado.';
  end if;

  if coalesce(v_order.payment_status, '') not in ('pendiente_comprobante', 'en_revision') then
    raise exception 'ALREADY_RESOLVED: el pago de este pedido ya no admite verificación automática.';
  end if;

  if v_order.transfer_verification_attempts >= p_max_attempts then
    raise exception 'MAX_ATTEMPTS_EXCEEDED: se alcanzó el máximo de intentos automáticos para este pedido.';
  end if;

  if v_order.transfer_verification_status = 'checking'
     and v_order.transfer_last_verification_at is not null
     and v_order.transfer_last_verification_at > v_now - make_interval(secs => p_stale_checking_seconds) then
    raise exception 'ALREADY_CHECKING: ya hay una verificación en curso para este pedido.';
  end if;

  if v_order.transfer_last_verification_at is not null
     and v_order.transfer_last_verification_at > v_now - make_interval(secs => p_min_interval_seconds) then
    raise exception 'RATE_LIMITED: esperá unos segundos antes de volver a intentar.';
  end if;

  update public.ordenes
  set
    transfer_verification_status = 'checking',
    transfer_verification_attempts = transfer_verification_attempts + 1,
    transfer_last_verification_at = v_now,
    transfer_verification_lease_id = v_lease_id
  where id = v_order.id
  returning *
  into v_order;

  return v_order;
end;
$$;

revoke all on function public.claim_transfer_verification_attempt(bigint, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_transfer_verification_attempt(bigint, integer, integer, integer)
  to service_role;

comment on function public.claim_transfer_verification_attempt(bigint, integer, integer, integer) is
  'Reclama de forma atómica un intento de verificación automática de transferencia. Genera y persiste un lease id nuevo (transfer_verification_lease_id) en cada claim exitoso -- ese lease es el que confirm_transfer_auto_verification exige para poder confirmar. Sirve como rate limit, lock anti doble-click/concurrencia y tope de intentos. No confirma nada por sí sola.';

-- confirm_transfer_auto_verification: firma final con validación de lease
-- completa (p_lease_id). Esta migración todavía no está aplicada
-- remotamente (ver encabezado), así que se reemplaza directamente la firma
-- de 11 parámetros de 20260914090000 por la de 12 acá -- nunca existió en
-- producción ninguna versión intermedia (12 con sólo uuid, ni 13 con
-- p_lease_ttl_seconds). Los DROP de abajo cubren las tres formas que este
-- archivo llegó a tener localmente durante el desarrollo, para que aplicar
-- esta versión final sea idempotente sin importar en cuál haya quedado un
-- entorno de prueba.
--
-- P0 (cuarta auditoría): la vigencia del lease NO puede depender de un
-- parámetro que el caller controla. La versión anterior de esta función
-- aceptaba p_lease_ttl_seconds sin validarlo -- Codex confirmó que un caller
-- podía pasar NULL (make_interval(secs => NULL) es NULL, "x <= NULL" es
-- NULL, y un IF con condición NULL en plpgsql se trata como FALSE: la
-- excepción LEASE_EXPIRED nunca se lanzaba) o un valor grande (3600) para
-- extender artificialmente la vigencia real del lease. La vigencia ahora es
-- un intervalo FIJO ('60 seconds', hardcodeado en el cuerpo de la función,
-- igual al p_stale_checking_seconds por defecto de claim_transfer_verification_attempt)
-- -- el parámetro se elimina directamente de la firma en vez de "aceptarlo
-- pero validarlo", que hubiera dejado innecesariamente una superficie de
-- API que no cumple ninguna función real.
drop function if exists public.confirm_transfer_auto_verification(
  bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz
);
drop function if exists public.confirm_transfer_auto_verification(
  bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz, uuid
);
drop function if exists public.confirm_transfer_auto_verification(
  bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz, uuid, integer
);

create function public.confirm_transfer_auto_verification(
  p_order_id bigint,
  p_matched_payment_id text,
  p_matched_operation_type text,
  p_matched_payment_method_id text,
  p_matched_amount numeric,
  p_matched_identification_type text,
  p_matched_identification_number text,
  p_matched_dni_derived text,
  p_matched_bank_transfer_id text,
  p_matched_date_created timestamptz,
  p_matched_date_approved timestamptz,
  p_lease_id uuid
)
returns public.ordenes
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := now();
  -- P0 (quinta auditoría): now() devuelve el timestamp de INICIO de la
  -- transacción -- queda congelado durante toda la ejecución, incluida
  -- cualquier espera real para adquirir el "for update" de abajo. Codex
  -- reprodujo: lease con 59s de antigüedad al arrancar la transacción, la
  -- transacción tarda/espera 2s más antes de evaluar la vigencia, la
  -- antigüedad REAL ya es 61s (vencida), pero now() seguía viendo 59s y la
  -- RPC confirmaba igual. v_lease_checked_at se asigna DESPUÉS del "for
  -- update" (más abajo) con clock_timestamp() -- tiempo de PARED real en el
  -- momento exacto de evaluar, nunca el de inicio de transacción -- y se usa
  -- ÚNICAMENTE para la comprobación de vigencia del lease. v_now se sigue
  -- usando para todo lo demás (timestamps de escritura: payment_confirmed_at,
  -- paid_at, transfer_last_verification_at, etc.) donde congelar el momento
  -- de inicio de transacción es el criterio correcto y no está relacionado
  -- con este bug.
  v_lease_checked_at timestamptz;
  v_previous_financial_status text;
  v_snapshot jsonb;
  v_expected_amount numeric;
  v_expected_cents bigint;
  v_matched_cents bigint;
  v_declared_cents bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  if coalesce(trim(p_matched_payment_id), '') = '' then
    raise exception 'INVALID_PAYMENT_ID: falta el identificador de Mercado Pago.';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = p_order_id
  for update;

  -- Tiempo real de PARED, tomado recién acá -- inmediatamente DESPUÉS de
  -- que el "for update" de arriba ya terminó de esperar (si tuvo que
  -- esperar). Nunca reutilizar v_now (congelado al inicio de la
  -- transacción) para la comprobación de vigencia del lease de más abajo.
  v_lease_checked_at := clock_timestamp();

  if not found then
    raise exception 'ORDER_NOT_FOUND: no encontramos el pedido.';
  end if;

  if v_order.payment_method_id is distinct from 'transferencia' then
    raise exception 'NOT_TRANSFER_ORDER: este pedido no corresponde a transferencia bancaria.';
  end if;

  if lower(coalesce(v_order.estado, '')) = 'cancelado' then
    raise exception 'ORDER_CANCELLED: el pedido está cancelado.';
  end if;

  if coalesce(v_order.payment_status, '') not in ('pendiente_comprobante', 'en_revision') then
    raise exception 'ALREADY_RESOLVED: el pago de este pedido ya no admite verificación automática.';
  end if;

  -- P0 (tercera auditoría): validación de lease COMPLETA, bajo el mismo
  -- FOR UPDATE de arriba -- las cinco condiciones exigidas, en el orden que
  -- da el diagnóstico más específico posible:
  --
  --  1) transfer_verification_status debe seguir siendo 'checking' (hubo un
  --     claim y nadie lo resolvió/liberó todavía) -> si no,
  --     INVALID_VERIFICATION_STATE. Cubre tanto "nunca se hizo claim"
  --     (status por defecto, nunca 'checking') como "ya se resolvió en
  --     manual_review/pending mientras tanto".
  --  2) p_lease_id y el lease vigente en la fila deben ser AMBOS no nulos
  --     -> si cualquiera es NULL, LEASE_MISSING. Esto es lo que la versión
  --     anterior de este chequeo (IS DISTINCT FROM) dejaba pasar: NULL IS
  --     NOT DISTINCT FROM NULL en Postgres.
  --  3) deben coincidir EXACTAMENTE -> si no, LEASE_MISMATCH (un intento
  --     más nuevo ya reclamó este pedido).
  --  4) transfer_last_verification_at (fijado por el claim que otorgó este
  --     lease) debe seguir dentro de una ventana de vigencia FIJA de 60
  --     segundos -- hardcodeada acá, nunca un parámetro que el caller pueda
  --     manipular (ver comentario más arriba, antes de los DROP) -> si no,
  --     LEASE_EXPIRED. Comparado contra v_lease_checked_at (clock_timestamp(),
  --     tiempo real tomado DESPUÉS del "for update" de arriba), nunca contra
  --     v_now (congelado al inicio de la transacción -- ver comentario en la
  --     declaración de v_lease_checked_at más arriba).
  --
  -- Si cualquiera de las cuatro falla: NO se toca ningún campo de la orden.
  if coalesce(v_order.transfer_verification_status, '') <> 'checking' then
    raise exception 'INVALID_VERIFICATION_STATE: el pedido no tiene una verificación automática en curso.';
  end if;

  if p_lease_id is null or v_order.transfer_verification_lease_id is null then
    raise exception 'LEASE_MISSING: falta el identificador del intento de verificación vigente.';
  end if;

  if p_lease_id <> v_order.transfer_verification_lease_id then
    raise exception 'LEASE_MISMATCH: el intento de verificación ya no es el vigente (fue reemplazado por uno nuevo).';
  end if;

  if v_order.transfer_last_verification_at is null
     or v_order.transfer_last_verification_at <= v_lease_checked_at - interval '60 seconds' then
    raise exception 'LEASE_EXPIRED: el intento de verificación vigente venció.';
  end if;

  if exists (
    select 1 from public.ordenes
    where transfer_matched_payment_id = p_matched_payment_id
      and id <> p_order_id
  ) then
    raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end if;

  -- P0 (segunda auditoría): claim histórico e insert-only, independiente del
  -- valor actual de ordenes.transfer_matched_payment_id (que esta misma
  -- orden podría sobrescribir más adelante con otro payment.id). Una vez
  -- reclamado acá, este payment.id queda atado a esta orden para siempre.
  insert into public.transfer_verification_payment_claims (payment_id, order_id)
  values (p_matched_payment_id, p_order_id)
  on conflict (payment_id) do nothing;

  if not exists (
    select 1 from public.transfer_verification_payment_claims
    where payment_id = p_matched_payment_id
      and order_id = p_order_id
  ) then
    raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
  end if;

  -- P0: monto esperado BAJO EL LOCK ya tomado arriba -- nunca el monto que
  -- el caller haya leído antes de invocar esta RPC (puede quedar
  -- desactualizado durante el tiempo que tarda la consulta a Mercado Pago).
  -- Mismo criterio de columnas que usa el resto del proyecto:
  -- external_amount_due si existe, si no total.
  v_expected_amount := coalesce(v_order.external_amount_due, v_order.total);
  v_expected_cents := round(coalesce(v_expected_amount, -1) * 100);
  v_matched_cents := round(coalesce(p_matched_amount, -1) * 100);

  if v_expected_cents is null or v_expected_cents <= 0
     or v_matched_cents is null or v_matched_cents <> v_expected_cents then
    raise exception 'AMOUNT_MISMATCH: el monto vigente del pedido no coincide con el importe de la transferencia.';
  end if;

  if v_order.transfer_amount_declared is not null then
    v_declared_cents := round(v_order.transfer_amount_declared * 100);
    if v_declared_cents <> v_matched_cents then
      raise exception 'AMOUNT_MISMATCH: el monto declarado no coincide con el importe vigente del pedido.';
    end if;
  end if;

  v_previous_financial_status := coalesce(
    v_order.financial_status,
    v_order.payment_status,
    'pending_payment'
  );
  v_snapshot := jsonb_build_object(
    'operationType', p_matched_operation_type,
    'paymentMethodId', p_matched_payment_method_id,
    'identificationType', p_matched_identification_type,
    'identificationNumber', p_matched_identification_number,
    'dniDerivado', p_matched_dni_derived,
    'bankTransferId', p_matched_bank_transfer_id,
    'dateCreated', p_matched_date_created,
    'dateApproved', p_matched_date_approved
  );

  begin
    update public.ordenes
    set
      payment_status = 'confirmado',
      estado = 'pagado',
      financial_status = 'payment_confirmed',
      paid_at = coalesce(v_order.paid_at, v_now),
      payment_confirmed_by = null,
      payment_confirmed_at = v_now,
      payment_confirmed_amount = p_matched_amount,
      order_change_status = 'change_approved',
      order_change_extra_amount = 0,
      transfer_verification_status = 'auto_verified',
      transfer_verification_failure_reason = null,
      transfer_last_verification_at = v_now,
      transfer_matched_payment_id = p_matched_payment_id,
      transfer_match_snapshot = v_snapshot
    where id = v_order.id
    returning *
    into v_order;
  exception
    when unique_violation then
      raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
    when others then
      if sqlerrm !~* 'CHECKOUT_STOCK_INSUFFICIENT' then
        raise;
      end if;

      -- El dinero YA fue identificado contra Mercado Pago (y ya quedó en el
      -- historial de claims de arriba): aunque el stock ya no alcance para
      -- confirmar la orden, el payment.id tiene que quedar reservado para
      -- ESTE pedido de forma atómica (mismo lock de fila tomado arriba por
      -- el "for update"). A propósito no toca estado/financial_status: eso
      -- evita que este UPDATE angosto dispare de nuevo el guardián de
      -- inventario.
      begin
        update public.ordenes
        set
          payment_status = 'auto_verified_stock_conflict',
          transfer_verification_status = 'manual_review',
          transfer_verification_failure_reason = 'stock_conflict',
          transfer_last_verification_at = v_now,
          transfer_matched_payment_id = p_matched_payment_id,
          transfer_match_snapshot = v_snapshot
        where id = v_order.id
        returning *
        into v_order;
      exception
        when unique_violation then
          raise exception 'TRANSFER_PAYMENT_ID_ALREADY_USED: esa transferencia ya fue utilizada para acreditar otro pedido.';
      end;

      insert into public.order_audit_events (
        order_id, actor_type, actor_id, action, previous_status, new_status, metadata
      )
      values (
        v_order.id, 'system', null, 'transfer_auto_verification_stock_conflict',
        v_previous_financial_status, v_previous_financial_status,
        jsonb_build_object(
          'provider', 'mercadopago',
          'matchedPaymentId', p_matched_payment_id,
          'matchedAmount', p_matched_amount,
          'reason', 'inventory_unavailable_at_confirmation'
        )
      );

      return v_order;
  end;

  insert into public.order_audit_events (
    order_id,
    actor_type,
    actor_id,
    action,
    previous_status,
    new_status,
    metadata
  )
  values (
    v_order.id,
    'system',
    null,
    'transfer_auto_verified',
    v_previous_financial_status,
    'payment_confirmed',
    jsonb_build_object(
      'provider', 'mercadopago',
      'matchedPaymentId', p_matched_payment_id,
      'matchedAmount', p_matched_amount,
      'operationType', p_matched_operation_type,
      'paymentMethodId', p_matched_payment_method_id
    )
  );

  return v_order;
end;
$$;

revoke all on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz, uuid)
  to service_role;

comment on function public.confirm_transfer_auto_verification(bigint, text, text, text, numeric, text, text, text, text, timestamptz, timestamptz, uuid) is
  'Confirma automáticamente un pedido por transferencia ya conciliado contra Mercado Pago. Exige, bajo el mismo FOR UPDATE: transfer_verification_status=checking (INVALID_VERIFICATION_STATE si no), p_lease_id y el lease de la fila ambos no nulos (LEASE_MISSING si no), coincidencia exacta (LEASE_MISMATCH si no) y vigencia por una ventana FIJA de 60 segundos hardcodeada en el cuerpo -- nunca un parámetro del caller -- comparada contra clock_timestamp() tomado DESPUÉS del FOR UPDATE, nunca contra now() (que queda congelado al inicio de la transacción y no refleja el tiempo real de espera del lock) (LEASE_EXPIRED si no). Revalida el monto esperado vigente BAJO LOCK contra el monto de la transferencia y el declarado. Reclama el payment.id en transfer_verification_payment_claims (insert-only, permanente, con backfill de lo reservado antes de esta migración) antes de confirmar -- ese historial, no la columna transfer_matched_payment_id, es la fuente de verdad de unicidad. Si el guardián de inventario rechaza la confirmación por falta de stock, reclama igual el payment.id de forma atómica (payment_status=auto_verified_stock_conflict). Idempotente ante payment.id repetido.';

commit;
