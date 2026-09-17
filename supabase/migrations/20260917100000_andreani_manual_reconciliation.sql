-- BLOQUEANTE 2 (auditoría Andreani Parte 3/4): hoy andreani_creation_status
-- = 'reconciliation_required' es un callejón sin salida -- ningún camino del
-- código puede sacarlo de ahí (el WHERE de claim_andreani_shipment_creation
-- nunca reclama sobre ese estado; el guard de cancelación de la Parte 1
-- tampoco lo permite; no existe ningún endpoint/RPC que lo resuelva). Esta
-- migración agrega:
--
--   1) public.sweep_stale_andreani_claims(): mueve 'claimed' vencido (>5 min)
--      a 'reconciliation_required', MISMA semántica y MISMO predicado que ya
--      usaba (embebido) claim_andreani_shipment_creation -- nunca libera un
--      claim todavía fresco (potencial POST activo), nunca llama a Andreani
--      (100% local/read-safe sobre datos ya persistidos). claim_andreani_shipment_creation
--      se redefine para llamar a esta función en vez de duplicar el UPDATE
--      -- una sola fuente del predicado, no dos copias que puedan divergir.
--
--   2) public.resolve_andreani_reconciliation(): único camino para sacar un
--      pedido de 'reconciliation_required'. Sólo admin/super_admin. Primero
--      barre el claim vencido de ESE pedido (si corresponde) para poder
--      operar también sobre un 'claimed' huérfano sin tocar uno fresco.
--      Dos resoluciones, ambas auditadas:
--        - 'created': el admin confirma (por fuera del sistema, con Andreani)
--          que el envío SÍ existe y aporta el envioId real -- se persiste
--          exactamente una vez (CAS: nunca pisa un andreani_envio_id ya
--          existente, nunca reintenta el POST).
--        - 'not_created': el admin confirma que Andreani NO llegó a crear
--          nada -- vuelve el pedido a 'failed' (mismo estado reintentable
--          que ya reclama claim_andreani_shipment_creation, no se inventa un
--          estado nuevo).
--      Bloqueada con `for update` (vía el SELECT) + condición en el UPDATE
--      final (CAS): concurrencia segura, sólo una resolución puede ganar.

create or replace function public.sweep_stale_andreani_claims()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_swept integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para esta operación.';
  end if;

  with swept as (
    update public.ordenes
    set
      andreani_creation_status = 'reconciliation_required',
      andreani_creation_claim_token = null,
      andreani_error = coalesce(
        andreani_error,
        'El intento venció sin resultado persistido; requiere conciliación manual.'
      )
    where nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
      and andreani_creation_status = 'claimed'
      and andreani_creation_claimed_at < now() - interval '5 minutes'
    returning 1
  )
  select count(*) into v_swept from swept;

  return v_swept;
end;
$$;

comment on function public.sweep_stale_andreani_claims() is
  'Mueve a reconciliation_required cualquier claim Andreani vencido (>5 min, sin envío persistido) -- 100% local, sin llamar a Andreani. Nunca toca un claim fresco.';

revoke all on function public.sweep_stale_andreani_claims() from public, anon, authenticated;
grant execute on function public.sweep_stale_andreani_claims() to service_role;

-- Redefinición byte a byte de claim_andreani_shipment_creation
-- (20260906120000_harden_andreani_commercial_and_order_writes.sql, ya
-- aplicada remotamente -- no se edita, se redefine con CREATE OR REPLACE,
-- mismo patrón que el resto del proyecto): el único cambio real es que el
-- barrido de claims vencidos ahora se delega a sweep_stale_andreani_claims()
-- en vez de repetir el mismo UPDATE inline -- una sola fuente del
-- predicado. El resto de la función (validaciones, claim atómico,
-- comentario) queda idéntico.
create or replace function public.claim_andreani_shipment_creation(
  p_order_id bigint,
  p_claim_token uuid,
  p_environment text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para generar este envío.';
  end if;

  if p_order_id is null or p_claim_token is null then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID';
  end if;

  if p_environment is null or p_environment not in ('QA', 'PROD') then
    raise exception 'ANDREANI_SHIPMENT_CLAIM_INVALID_ENVIRONMENT';
  end if;

  -- La ausencia, un JSON inválido o enabled=false bloquean todo claim nuevo.
  perform 1 from public.site_settings
  where key = 'andreani_commercial' and value -> 'enabled' = 'true'::jsonb
  for share;
  if not found then
    return null;
  end if;

  -- Un claim vencido es ambiguo aunque haya sido tomado en otro ambiente:
  -- no puede abrirse otro POST hasta conciliar el resultado externo. Misma
  -- semántica que antes, ahora factorizada en sweep_stale_andreani_claims()
  -- para que resolve_andreani_reconciliation() pueda reutilizarla sin
  -- duplicar el predicado.
  perform public.sweep_stale_andreani_claims();

  update public.ordenes
  set
    andreani_creation_status = 'claimed',
    andreani_creation_claim_token = p_claim_token,
    andreani_creation_claimed_at = now(),
    andreani_creation_environment = p_environment,
    andreani_creation_attempts = coalesce(andreani_creation_attempts, 0) + 1
  where id = p_order_id
    and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    and (
      andreani_creation_status is null
      or andreani_creation_status = 'failed'
      -- Rechazo determinístico (400/422): Andreani no creó nada, así que
      -- es reclamable en cualquier ambiente, incluido el mismo que lo
      -- rechazó, sin esperar a que cambie QA<->PROD.
      or andreani_creation_status = 'rejected'
    )
    and lower(coalesce(estado, '')) in ('pendiente', 'pagado')
    and lower(coalesce(shipping_provider, envio_proveedor, '')) = 'andreani'
    and lower(coalesce(financial_status, '')) not in (
      'cancellation_requested',
      'cancelled',
      'refund_pending',
      'refunded'
    )
    and shipping_type in ('domicilio', 'sucursal')
    and (
      paid_at is not null
      or coalesce(payment_confirmed_amount, 0) > 0
      or lower(coalesce(payment_status, '')) in (
        'confirmado',
        'approved',
        'confirmed'
      )
      or lower(coalesce(financial_status, '')) = 'payment_confirmed'
    )
    and invoice_status = 'authorized'
    and nullif(btrim(coalesce(invoice_cae, '')), '') is not null
    and invoice_number is not null
    and invoice_point is not null
  returning andreani_creation_attempts into v_attempts;

  return v_attempts;
end;
$$;

comment on function public.claim_andreani_shipment_creation(bigint, uuid, text) is
  'Reclama atómicamente una creación Andreani para un pedido pagado, facturado y sin resultado externo ambiguo pendiente, en modalidad domicilio o sucursal; un rechazo determinístico previo (400/422) no bloquea el reclamo. El barrido de claims vencidos vive en sweep_stale_andreani_claims().';

notify pgrst, 'reload schema';

revoke all on function public.claim_andreani_shipment_creation(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_andreani_shipment_creation(bigint, uuid, text) to service_role;

create or replace function public.resolve_andreani_reconciliation(
  p_order_id bigint,
  p_admin_id uuid,
  p_admin_role text,
  p_resolution text,
  p_envio_id text,
  p_tracking text,
  p_etiqueta_url text,
  p_notes text
)
returns public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_resolution text;
  v_envio_id text;
  v_tracking text;
  v_etiqueta_url text;
  v_notes text;
  v_previous_status text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para conciliar este pedido.';
  end if;

  -- Deliberadamente más angosto que admin_cancel_order (que sí admite
  -- 'operador'): pedido explícito de la auditoría -- "sólo admin/super_admin
  -- según roles reales" para esta operación específica.
  if p_admin_id is null or coalesce(p_admin_role, '') not in ('admin', 'super_admin') then
    raise exception 'ANDREANI_RECONCILIATION_FORBIDDEN';
  end if;

  v_resolution := lower(coalesce(p_resolution, ''));
  if v_resolution not in ('created', 'not_created') then
    raise exception 'ANDREANI_RECONCILIATION_INVALID_RESOLUTION';
  end if;

  v_notes := nullif(trim(coalesce(p_notes, '')), '');
  if v_notes is null or length(v_notes) < 5 or length(v_notes) > 1000 then
    raise exception 'ANDREANI_RECONCILIATION_INVALID_NOTES';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  -- Self-heal de un claim vencido de ESTE pedido específico, misma
  -- semántica y misma función que ya usa claim_andreani_shipment_creation --
  -- nunca toca un claim todavía fresco (sweep_stale_andreani_claims() sólo
  -- mueve claims con más de 5 minutos). Se re-lee la fila porque el sweep
  -- pudo haberla cambiado.
  perform public.sweep_stale_andreani_claims();
  select * into v_order from public.ordenes where id = p_order_id for update;

  v_previous_status := v_order.andreani_creation_status;

  if v_order.andreani_creation_status is distinct from 'reconciliation_required' then
    raise exception 'ANDREANI_RECONCILIATION_NOT_PENDING';
  end if;

  if v_resolution = 'created' then
    v_envio_id := nullif(trim(coalesce(p_envio_id, '')), '');
    if v_envio_id is null or length(v_envio_id) > 100 then
      raise exception 'ANDREANI_RECONCILIATION_INVALID_ENVIO_ID';
    end if;
    v_tracking := nullif(trim(coalesce(p_tracking, '')), '');
    if v_tracking is not null and length(v_tracking) > 100 then
      raise exception 'ANDREANI_RECONCILIATION_INVALID_TRACKING';
    end if;
    v_etiqueta_url := nullif(trim(coalesce(p_etiqueta_url, '')), '');
    if v_etiqueta_url is not null and (
      length(v_etiqueta_url) > 2000 or v_etiqueta_url !~ '^https?://'
    ) then
      raise exception 'ANDREANI_RECONCILIATION_INVALID_LABEL_URL';
    end if;

    -- Nunca pisa un envío ya persistido por otra vía mientras tanto.
    if nullif(btrim(coalesce(v_order.andreani_envio_id, '')), '') is not null then
      raise exception 'ANDREANI_SHIPMENT_ALREADY_PERSISTED';
    end if;

    update public.ordenes
    set
      andreani_envio_id = v_envio_id,
      andreani_tracking = coalesce(v_tracking, andreani_tracking),
      andreani_etiqueta_url = coalesce(v_etiqueta_url, andreani_etiqueta_url),
      andreani_creation_status = 'created',
      andreani_creation_claim_token = null,
      andreani_error = null
    where id = v_order.id
      and andreani_creation_status = 'reconciliation_required'
      and nullif(btrim(coalesce(andreani_envio_id, '')), '') is null
    returning * into v_order;

    if not found then
      raise exception 'ANDREANI_RECONCILIATION_CONFLICT';
    end if;
  else
    -- 'failed' es el mismo estado reintentable que ya acepta el WHERE de
    -- claim_andreani_shipment_creation -- no se inventa un estado nuevo.
    update public.ordenes
    set
      andreani_creation_status = 'failed',
      andreani_creation_claim_token = null,
      andreani_error = 'Conciliado manualmente: Andreani no llegó a crear el envío.'
    where id = v_order.id
      and andreani_creation_status = 'reconciliation_required'
    returning * into v_order;

    if not found then
      raise exception 'ANDREANI_RECONCILIATION_CONFLICT';
    end if;
  end if;

  insert into public.order_audit_events (
    order_id, actor_type, actor_id, action, previous_status, new_status, metadata
  ) values (
    v_order.id,
    'admin',
    p_admin_id,
    'andreani_reconciliation_resolved',
    v_previous_status,
    v_order.andreani_creation_status,
    jsonb_build_object(
      'resolution', v_resolution,
      'notes', v_notes,
      'envioId', case when v_resolution = 'created' then v_envio_id else null end,
      'tracking', case when v_resolution = 'created' then v_tracking else null end
    )
  );

  return v_order;
end;
$$;

comment on function public.resolve_andreani_reconciliation(bigint, uuid, text, text, text, text, text, text) is
  'Único camino para resolver andreani_creation_status=reconciliation_required (o un claimed vencido de ese pedido): admin/super_admin confirma si Andreani creó el envío (created, con referencia real) o no (not_created, vuelve a failed/reintentable). Atómico, auditado, nunca pisa un envío ya persistido ni libera un claim fresco.';

revoke all on function public.resolve_andreani_reconciliation(bigint, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_andreani_reconciliation(bigint, uuid, text, text, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';
