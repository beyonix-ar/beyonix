-- Corrección de la logística de postventa sobre 20260928100000 (ya aplicada).
--
-- 20260928100000 dejó en producción el modelo inicial: tramos 'devolucion'
-- (con retiro en domicilio) y 'reemplazo' (con entrega a domicilio), un tramo
-- de devolución abierto AUTOMÁTICAMENTE al aceptar un cambio y ningún registro
-- del paradero de cada unidad. Esta migración lleva la base al modelo final:
--
--   * Postventa SÓLO por sucursal Andreani, con la sucursal de cada tramo
--     (branch_id): CAMBIO sucursal, RETIRO sucursal y reenvío por VENTA
--     sucursal. Ninguna modalidad de domicilio para tramos nuevos.
--   * Nada automático: aceptar un reclamo sólo deja mensajes; el Admin elige
--     explícitamente "Cambio directo" o "Retiro + revisión + reenvío".
--   * order_claim_units: paradero lógico de cada unidad (original/reemplazo);
--     recepción física separada de la inspección; incidencias tipificadas que
--     bloquean reenvío, operaciones, NC/reintegro y cierre.
--   * Intentos numerados, un solo tramo abierto por reclamo, cambio no
--     completado, conciliación, tracking monotónico con marca de novedad.
--   * Reservas de reemplazo: tope por lo reclamado, reservas devueltas
--     (reverted_quantity) y nunca antes del método / la inspección.
--   * Guardas de cierre y de cambio de resolución con logística en curso.
--
-- FILAS HEREDADAS (creadas por 20260928100000 antes de esta migración):
--   * se marcan legacy = true (no tienen sucursal ni unidades);
--   * las abiertas automáticamente que nunca llegaron a Andreani
--     (pendiente / not_started|failed) se CANCELAN, con evento de auditoría:
--     el Admin elige el método de nuevo;
--   * status 'incidencia' pasa a 'generada' + incident_open (el tracking
--     monotónico vuelve a avanzar en la próxima consulta);
--   * las entregadas quedan cerradas;
--   * una operación real heredada (creada, en curso o a conciliar) se conserva
--     tal cual (incluida su modalidad original): se sigue, se concilia y se
--     cierra con las funciones nuevas, nunca se reenvía ni se duplica.
--
-- Idempotente: puede ejecutarse más de una vez sin efectos dobles.

begin;

-- 0. Mensajes automáticos idempotentes (ya existe desde 20260928100000) ----

alter table public.order_claim_messages
  add column if not exists system_key text;
create unique index if not exists order_claim_messages_system_key_unique
  on public.order_claim_messages (claim_id, system_key)
  where system_key is not null;

-- 1. Reemplazos devueltos -------------------------------------------------

alter table public.order_replacements
  add column if not exists reverted_quantity integer not null default 0;
alter table public.order_replacements
  drop constraint if exists order_replacements_reverted_quantity_check;
alter table public.order_replacements
  add constraint order_replacements_reverted_quantity_check
  check (reverted_quantity >= 0 and reverted_quantity <= quantity);

comment on column public.order_replacements.reverted_quantity is
  'Unidades del reemplazo que volvieron a BEYONIX sin llegar al cliente (reincorporadas o dadas de baja tras inspección, o reserva liberada). No cuentan como reemplazo entregado.';

-- 2. order_claim_shipments: del modelo inicial al final -------------------

alter table public.order_claim_shipments
  add column if not exists attempt smallint not null default 1,
  add column if not exists exchange_outcome text,
  add column if not exists branch_id text,
  add column if not exists branch_name text,
  add column if not exists branch_address text,
  add column if not exists incident_open boolean not null default false,
  add column if not exists incident_event text,
  add column if not exists incident_at timestamptz,
  add column if not exists branch_custody_since timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists legacy boolean not null default false,
  -- Evento de Andreani que no se puede clasificar con seguridad (fuera del
  -- maestro, anulación, siniestro, rescate, cambio de destino...): congela
  -- el avance automático hasta que un Admin lo revise (auditado).
  add column if not exists review_required boolean not null default false,
  add column if not exists review_event text,
  add column if not exists review_at timestamptz,
  add column if not exists review_acknowledged text[] not null default '{}';

-- Reclamos anteriores a esta migración: se marcan una sola vez (al crear la
-- columna) como "legacy". No se les inventan unidades ni se transforman: siguen
-- con su flujo; sólo pueden pasar al circuito nuevo si nunca tuvieron
-- movimientos logísticos ni de stock (ver request_order_claim_logistics).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_claims' and column_name = 'logistics_legacy'
  ) then
    -- Existentes = true sin UPDATE masivo (no toca updated_at ni dispara
    -- triggers de reclamos); nuevos = false.
    alter table public.order_claims add column logistics_legacy boolean not null default true;
    alter table public.order_claims alter column logistics_legacy set default false;
  end if;
end;
$$;

comment on column public.order_claims.logistics_legacy is
  'Reclamo anterior al circuito logístico por sucursal (20260930100000). No tiene unidades; sigue su flujo original.';

-- Reglas viejas (y nuevas, para poder re-ejecutar) fuera antes de corregir datos.
alter table public.order_claim_shipments
  drop constraint if exists order_claim_shipments_one_per_direction,
  drop constraint if exists order_claim_shipments_direction_check,
  drop constraint if exists order_claim_shipments_status_check,
  drop constraint if exists order_claim_shipments_modality,
  drop constraint if exists order_claim_shipments_status_requires_creation,
  drop constraint if exists order_claim_shipments_attempt_unique,
  drop constraint if exists order_claim_shipments_attempt_check,
  drop constraint if exists order_claim_shipments_exchange_outcome_check,
  drop constraint if exists order_claim_shipments_outcome_only_exchange,
  drop constraint if exists order_claim_shipments_branch_check,
  drop constraint if exists order_claim_shipments_cancel_closes,
  drop constraint if exists order_claim_shipments_cancel_not_in_flight;

-- Filas heredadas del modelo inicial (sin sucursal).
update public.order_claim_shipments set legacy = true where branch_id is null and not legacy;

update public.order_claim_shipments
set status = 'generada',
    incident_open = true,
    incident_event = coalesce(incident_event, andreani_last_event),
    incident_at = coalesce(incident_at, andreani_last_event_at, updated_at),
    updated_at = now()
where status = 'incidencia';

update public.order_claim_shipments
set closed_at = coalesce(delivered_at, now())
where status = 'entregada' and closed_at is null;

with cancelled as (
  update public.order_claim_shipments
  set status = 'cancelada', closed_at = now(), updated_at = now()
  where legacy and closed_at is null and status = 'pendiente' and creation_status in ('not_started', 'failed')
  returning id, claim_id, order_id, direction
)
insert into public.order_audit_events (order_id, actor_type, action, metadata)
select order_id, 'system', 'claim_logistics_cancelled',
  jsonb_build_object('claimId', claim_id, 'shipmentId', id, 'direction', direction, 'reason', 'legacy_auto_opened')
from cancelled;

alter table public.order_claim_shipments
  add constraint order_claim_shipments_direction_check check (direction in ('devolucion', 'cambio', 'reemplazo')),
  add constraint order_claim_shipments_attempt_check check (attempt between 1 and 5),
  add constraint order_claim_shipments_status_check
    check (status in ('pendiente', 'generada', 'en_transito', 'en_sucursal', 'entregada', 'cancelada')),
  add constraint order_claim_shipments_exchange_outcome_check check (exchange_outcome in ('completado', 'no_completado')),
  add constraint order_claim_shipments_attempt_unique unique (claim_id, direction, attempt),
  -- Toda operación nueva tiene sucursal; sólo las heredadas pueden no tenerla.
  add constraint order_claim_shipments_branch_check check (legacy or coalesce(branch_id, '') ~ '^[0-9]{1,12}$'),
  -- Sólo sucursal. Las modalidades de domicilio quedan únicamente en filas heredadas.
  add constraint order_claim_shipments_modality check (
    modality is null
    or (direction = 'devolucion' and modality = 'despacho_sucursal')
    or (direction = 'cambio' and modality = 'cambio_sucursal')
    or (direction = 'reemplazo' and modality = 'entrega_sucursal')
    or (legacy and ((direction = 'devolucion' and modality = 'retiro_domicilio')
                    or (direction = 'reemplazo' and modality = 'entrega_domicilio')))
  ),
  add constraint order_claim_shipments_outcome_only_exchange check (exchange_outcome is null or direction = 'cambio'),
  add constraint order_claim_shipments_status_requires_creation check (
    status in ('pendiente', 'cancelada') or creation_status = 'created'
  ),
  add constraint order_claim_shipments_cancel_closes check (status <> 'cancelada' or closed_at is not null),
  add constraint order_claim_shipments_cancel_not_in_flight check (
    status <> 'cancelada' or creation_status in ('not_started', 'failed', 'created')
  );

comment on table public.order_claim_shipments is
  'Tramos Andreani de un reclamo, siempre por sucursal (cambio directo, retiro, reenvío). Nunca modifican stock: sólo mueven la ubicación lógica de order_claim_units.';
comment on column public.order_claim_shipments.branch_id is
  'Sucursal Andreani del tramo (idgla): donde el cliente entrega (retiro) o retira/intercambia (cambio, reenvío). NULL sólo en filas heredadas.';
comment on column public.order_claim_shipments.legacy is
  'Fila creada por el modelo inicial (20260928100000): sin sucursal ni unidades. Se sigue y concilia; nunca se usa para operaciones nuevas.';
comment on column public.order_claim_shipments.branch_custody_since is
  'Inicio de custodia en sucursal informado por Andreani. El plazo de permanencia no se calcula: Andreani no lo informa.';

-- A lo sumo un tramo abierto por reclamo (las filas heredadas pueden tener
-- dos abiertos: se siguen hasta cerrarse, pero bloquean abrir otro).
create unique index if not exists order_claim_shipments_one_open_per_claim
  on public.order_claim_shipments (claim_id)
  where closed_at is null and not legacy;
drop index if exists public.order_claim_shipments_tracking_queue_idx;
create index order_claim_shipments_tracking_queue_idx
  on public.order_claim_shipments (last_checked_at nulls first, id)
  where creation_status = 'created' and closed_at is null;

-- Escrituras sólo por funciones security definer.
revoke insert, update, delete on table public.order_claim_shipments from service_role;
grant select on table public.order_claim_shipments to service_role;

-- 3. Unidades del reclamo ------------------------------------------------

create table if not exists public.order_claim_units (
  id bigint generated by default as identity primary key,
  claim_id bigint not null references public.order_claims(id) on delete restrict,
  order_id bigint not null references public.ordenes(id) on delete restrict,
  order_item_id bigint not null references public.orden_items(id) on delete restrict,
  role text not null check (role in ('original', 'reemplazo')),
  replacement_id bigint references public.order_replacements(id) on delete restrict,
  shipment_id bigint references public.order_claim_shipments(id) on delete restrict,
  location text not null,
  incident_open boolean not null default false,
  -- Resultado de la inspección física que abre la incidencia. No existe hoy
  -- registro de números de serie: no se inventa esa infraestructura.
  incident_type text check (incident_type in (
    'producto_distinto', 'cantidad_incorrecta', 'faltantes_accesorios', 'paquete_vacio', 'dano_estado', 'otro')),
  incident_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_claim_units_incident_type check (not incident_open or incident_type is not null),
  constraint order_claim_units_replacement_link check ((role = 'reemplazo') = (replacement_id is not null)),
  constraint order_claim_units_location check (
    (role = 'original' and location in ('con_cliente', 'en_andreani', 'recibida_beyonix', 'reincorporada_stock', 'baja', 'conservada_cliente'))
    or (role = 'reemplazo' and location in ('reservada', 'en_andreani', 'entregada_cliente', 'recibida_beyonix', 'reincorporada_stock', 'baja'))
  ),
  constraint order_claim_units_incident_note check (not incident_open or incident_note is not null)
);

comment on table public.order_claim_units is
  'Paradero lógico de cada unidad de un reclamo con logística (original y reemplazo). Única fuente de verdad: ninguna unidad sin ubicación.';

create index if not exists order_claim_units_claim_idx on public.order_claim_units (claim_id, role, order_item_id, location);
create index if not exists order_claim_units_shipment_idx on public.order_claim_units (shipment_id) where shipment_id is not null;
create index if not exists order_claim_units_replacement_idx on public.order_claim_units (replacement_id) where replacement_id is not null;

alter table public.order_claim_units enable row level security;
revoke all on table public.order_claim_units from public, anon, authenticated;
grant select on table public.order_claim_units to service_role;

-- Ledger de acciones del Admin sobre unidades: idempotencia (doble click,
-- reintento, dos pestañas) y auditoría.
create table if not exists public.order_claim_unit_events (
  id bigint generated by default as identity primary key,
  claim_id bigint not null references public.order_claims(id) on delete restrict,
  idempotency_key text not null unique,
  action text not null,
  actor_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.order_claim_unit_events enable row level security;
revoke all on table public.order_claim_unit_events from public, anon, authenticated;
grant select on table public.order_claim_unit_events to service_role;


-- 4. Utilidades ----------------------------------------------------------

create or replace function public.order_claim_leg_rank(p_status text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_status
    when 'pendiente' then 0 when 'generada' then 1 when 'en_transito' then 2
    when 'en_sucursal' then 3 when 'entregada' then 4 else -1 end
$$;

create or replace function public.post_order_claim_system_message(
  p_claim_id bigint,
  p_key text,
  p_message text,
  p_needs_admin boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.order_claim_messages (claim_id, author_user_id, author_role, message, system_key, created_at)
  values (p_claim_id, null, 'admin', p_message, p_key, clock_timestamp())
  on conflict (claim_id, system_key) where system_key is not null do nothing
  returning id into v_id;
  -- Después del mensaje: sync_order_claim_admin_attention apaga la atención
  -- ante un mensaje de BEYONIX, y este aviso al Admin tiene que quedar.
  if p_needs_admin then
    update public.order_claims set admin_needs_action = true
    where id = p_claim_id and status not in ('cerrado', 'rechazado');
  end if;
  return v_id is not null;
end;
$$;

create or replace function public.log_order_claim_logistics(
  p_claim_id bigint,
  p_actor_id uuid,
  p_action text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_audit_events (order_id, actor_type, actor_id, action, metadata)
  select c.order_id, case when p_actor_id is null then 'system' else 'admin' end, p_actor_id, p_action,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('claimId', p_claim_id)
  from public.order_claims c where c.id = p_claim_id;
end;
$$;

-- Admin (no operador) con service_role. Devuelve el rol.
create or replace function public.assert_order_claim_logistics_admin(p_actor_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select rol into v_role from public.profiles where id = p_actor_id;
  if coalesce(v_role, '') not in ('admin', 'super_admin') then raise exception 'CLAIM_LOGISTICS_FORBIDDEN'; end if;
  return v_role;
end;
$$;

-- Registra la clave de una acción del Admin. true = primera vez; false = ya
-- aplicada con la MISMA acción (reintento). Otra acción con la misma clave falla.
create or replace function public.begin_order_claim_unit_event(
  p_claim_id bigint,
  p_key text,
  p_action text,
  p_actor_id uuid,
  p_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.order_claim_unit_events%rowtype;
begin
  -- <= 200: la clave se reusa como sufijo de la de stock (máximo 240).
  if p_key is null or length(btrim(p_key)) < 8 or length(p_key) > 200 then
    raise exception 'CLAIM_LOGISTICS_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('claim-unit-event:' || p_key, 0));
  select * into v_existing from public.order_claim_unit_events where idempotency_key = p_key;
  if found then
    if v_existing.claim_id <> p_claim_id or v_existing.action <> p_action then
      raise exception 'CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT';
    end if;
    return false;
  end if;
  insert into public.order_claim_unit_events (claim_id, idempotency_key, action, actor_id, payload)
  values (p_claim_id, p_key, p_action, p_actor_id, coalesce(p_payload, '{}'::jsonb));
  return true;
end;
$$;

-- Unidades originales desde affected_items (una fila por unidad). Sólo la
-- primera vez: después la base es la de las unidades.
create or replace function public.ensure_order_claim_original_units(p_claim public.order_claims)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if exists (select 1 from public.order_claim_units where claim_id = p_claim.id and role = 'original') then
    return 0;
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_claim.affected_items, '[]'::jsonb)) x
    where not exists (
      select 1 from public.orden_items i
      where i.id = (x->>'order_item_id')::bigint and i.orden_id = p_claim.order_id
        and (x->>'quantity')::integer between 1 and i.cantidad
    )
  ) then
    raise exception 'CLAIM_INVALID_ITEMS';
  end if;
  -- Una recepción ya registrada para este reclamo (posterior a su creación;
  -- hay un solo reclamo activo por pedido) se respeta: esas unidades ya están
  -- en BEYONIX y clasificadas, nunca vuelven a figurar "con el cliente".
  insert into public.order_claim_units (claim_id, order_id, order_item_id, role, location)
  select p_claim.id, p_claim.order_id, item.order_item_id, 'original',
    case
      when unit.n <= least(item.restocked, item.quantity) then 'reincorporada_stock'
      when unit.n <= least(item.restocked + item.written_off, item.quantity) then 'baja'
      else 'con_cliente'
    end
  from (
    select (x->>'order_item_id')::bigint order_item_id, (x->>'quantity')::integer quantity,
      coalesce((select sum(m.sellable_quantity + m.discounted_quantity) from public.inventory_return_movements m
                where m.order_item_id = (x->>'order_item_id')::bigint and m.created_at >= p_claim.created_at), 0)::integer restocked,
      coalesce((select sum(m.non_sellable_quantity) from public.inventory_return_movements m
                where m.order_item_id = (x->>'order_item_id')::bigint and m.created_at >= p_claim.created_at), 0)::integer written_off
    from jsonb_array_elements(coalesce(p_claim.affected_items, '[]'::jsonb)) x
  ) item
  cross join lateral generate_series(1, item.quantity) as unit(n)
  order by item.order_item_id, unit.n;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Estados en los que BEYONIX ya aceptó una solución y el reclamo sigue abierto.
create or replace function public.order_claim_is_accepted(p_claim public.order_claims)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_claim.status in ('aprobado', 'reintegro_pendiente', 'cambio_pendiente', 'cupon_pendiente')
    and p_claim.resolution is not null and p_claim.resolution <> 'rechazado'
    and coalesce(p_claim.failure_type, '') not in ('consulta_pedido', 'cancelar_compra')
$$;

-- Abre un tramo nuevo (siguiente intento). Nunca dos abiertos a la vez.
create or replace function public.open_order_claim_leg(
  p_claim public.order_claims,
  p_direction text,
  p_actor_id uuid,
  p_branch_id text,
  p_branch_name text,
  p_branch_address text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_attempt integer;
begin
  if exists (select 1 from public.order_claim_shipments where claim_id = p_claim.id and closed_at is null) then
    raise exception 'CLAIM_LOGISTICS_OPEN';
  end if;
  if coalesce(btrim(p_branch_id), '') !~ '^[0-9]{1,12}$' then raise exception 'CLAIM_LOGISTICS_BRANCH_REQUIRED'; end if;
  select coalesce(max(attempt), 0) + 1 into v_attempt
  from public.order_claim_shipments where claim_id = p_claim.id and direction = p_direction;
  if v_attempt > 5 then raise exception 'CLAIM_LOGISTICS_ATTEMPTS'; end if;
  perform public.ensure_order_claim_original_units(p_claim);
  insert into public.order_claim_shipments (claim_id, order_id, direction, attempt, branch_id, branch_name, branch_address)
  values (p_claim.id, p_claim.order_id, p_direction, v_attempt, btrim(p_branch_id),
    nullif(left(btrim(coalesce(p_branch_name, '')), 160), ''), nullif(left(btrim(coalesce(p_branch_address, '')), 240), ''))
  returning * into v_leg;
  perform public.log_order_claim_logistics(p_claim.id, p_actor_id, 'claim_logistics_opened',
    jsonb_build_object('shipmentId', v_leg.id, 'direction', p_direction, 'attempt', v_attempt, 'branchId', v_leg.branch_id));
  return v_leg;
end;
$$;

-- Plan logístico vigente del reclamo según sus operaciones (la última no
-- cancelada): 'cambio' (cambio directo) o 'retiro' (retiro + revisión, que
-- incluye su reenvío). NULL = el Admin todavía no eligió.
create or replace function public.order_claim_logistics_plan(p_claim_id bigint)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case direction when 'cambio' then 'cambio' else 'retiro' end
  from public.order_claim_shipments
  where claim_id = p_claim_id and status <> 'cancelada'
  order by id desc
  limit 1
$$;

-- Originales recibidos E inspeccionados (stock o baja, o excepción), sin
-- incidencias: condición para reenviar un reemplazo o reintegrar.
create or replace function public.order_claim_originals_inspected(p_claim_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original')
    and not exists (select 1 from public.order_claim_units
                    where claim_id = p_claim_id and role = 'original'
                      and location in ('con_cliente', 'en_andreani', 'recibida_beyonix'))
    and not exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
$$;

-- ¿Se puede generar la operación Andreani de este tramo? NULL = sí; si no,
-- el código del motivo.
create or replace function public.order_claim_leg_readiness(p_leg public.order_claim_shipments)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Una incidencia abierta frena cualquier operación hasta resolverla.
  if exists (select 1 from public.order_claim_units where claim_id = p_leg.claim_id and incident_open) then
    return 'CLAIM_LOGISTICS_INCIDENT';
  end if;
  if p_leg.direction = 'devolucion' then
    if not exists (select 1 from public.order_claim_units
                   where claim_id = p_leg.claim_id and role = 'original' and location = 'con_cliente') then
      return 'CLAIM_SHIPMENT_NOT_READY';
    end if;
    return null;
  end if;

  if p_leg.direction = 'cambio' then
    if not exists (select 1 from public.order_claim_units
                   where claim_id = p_leg.claim_id and role = 'original' and location = 'con_cliente') then
      return 'CLAIM_SHIPMENT_NOT_READY';
    end if;
    -- Cada unidad original que el cliente entrega tiene su reemplazo reservado.
    if exists (
      select 1
      from (select order_item_id, count(*) n from public.order_claim_units
            where claim_id = p_leg.claim_id and role = 'original' and location = 'con_cliente'
            group by order_item_id) o
      where o.n > (select count(*) from public.order_claim_units r
                   where r.claim_id = p_leg.claim_id and r.role = 'reemplazo' and r.location = 'reservada'
                     and r.order_item_id = o.order_item_id and (r.shipment_id is null or r.shipment_id = p_leg.id))
    ) then
      return 'CLAIM_SHIPMENT_NOT_READY_RESERVATION';
    end if;
    return null;
  end if;

  -- Reenvío (venta sucursal): sólo con el original recibido E inspeccionado.
  if not public.order_claim_originals_inspected(p_leg.claim_id) then
    return 'CLAIM_SHIPMENT_NOT_READY_RECEPTION';
  end if;
  if not exists (select 1 from public.order_claim_units
                 where claim_id = p_leg.claim_id and role = 'reemplazo' and location = 'reservada'
                   and (shipment_id is null or shipment_id = p_leg.id)) then
    return 'CLAIM_SHIPMENT_NOT_READY_RESERVATION';
  end if;
  return null;
end;
$$;

-- Asigna al tramo exactamente las unidades que viajan en él.
create or replace function public.assign_order_claim_leg_units(p_leg public.order_claim_shipments)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_leg.direction in ('devolucion', 'cambio') then
    update public.order_claim_units set shipment_id = p_leg.id, updated_at = clock_timestamp()
    where claim_id = p_leg.claim_id and role = 'original' and location = 'con_cliente';
  end if;
  if p_leg.direction = 'cambio' then
    update public.order_claim_units u set shipment_id = p_leg.id, updated_at = clock_timestamp()
    from (
      select r.id,
        row_number() over (partition by r.order_item_id order by r.id) rn,
        (select count(*) from public.order_claim_units o
         where o.claim_id = p_leg.claim_id and o.role = 'original' and o.location = 'con_cliente'
           and o.order_item_id = r.order_item_id) needed
      from public.order_claim_units r
      where r.claim_id = p_leg.claim_id and r.role = 'reemplazo' and r.location = 'reservada'
        and (r.shipment_id is null or r.shipment_id = p_leg.id)
    ) picked
    where u.id = picked.id and picked.rn <= picked.needed;
  elsif p_leg.direction = 'reemplazo' then
    update public.order_claim_units set shipment_id = p_leg.id, updated_at = clock_timestamp()
    where claim_id = p_leg.claim_id and role = 'reemplazo' and location = 'reservada' and shipment_id is null;
  end if;
end;
$$;

-- Libera las unidades de un tramo que NO llegó a existir en Andreani (o se
-- anuló antes de salir): vuelven a estar disponibles para otro tramo.
create or replace function public.release_order_claim_leg_units(p_leg_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.order_claim_units set shipment_id = null, updated_at = clock_timestamp()
  where shipment_id = p_leg_id and location in ('con_cliente', 'reservada');
end;
$$;

-- Cierra el tramo cuando ya no queda nada físico pendiente de Andreani.
create or replace function public.refresh_order_claim_leg_closure(p_leg_id bigint)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_pending boolean;
begin
  select * into v_leg from public.order_claim_shipments where id = p_leg_id;
  if not found or v_leg.closed_at is not null or v_leg.creation_status <> 'created' then return v_leg; end if;
  -- Heredadas: sin unidades que mirar; se cierran sólo con la entrega.
  if v_leg.legacy then return v_leg; end if;

  if v_leg.direction = 'devolucion' then
    v_pending := v_leg.status <> 'entregada' and exists (
      select 1 from public.order_claim_units where shipment_id = v_leg.id and role = 'original' and location in ('con_cliente', 'en_andreani'));
  elsif v_leg.direction = 'reemplazo' then
    v_pending := exists (
      select 1 from public.order_claim_units where shipment_id = v_leg.id and role = 'reemplazo' and location in ('reservada', 'en_andreani'));
  else
    v_pending := v_leg.exchange_outcome is distinct from 'completado' and exists (
      select 1 from public.order_claim_units where shipment_id = v_leg.id and role = 'reemplazo' and location in ('reservada', 'en_andreani'));
  end if;

  if not v_pending then
    update public.order_claim_shipments
    set closed_at = clock_timestamp(),
        exchange_outcome = case when direction = 'cambio' then coalesce(exchange_outcome, 'no_completado') else exchange_outcome end,
        updated_at = clock_timestamp()
    where id = v_leg.id
    returning * into v_leg;
  end if;
  return v_leg;
end;
$$;

-- 5. Aceptación del cambio: sólo mensajes ---------------------------------

create or replace function public.order_claim_change_accepted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  if new.resolution is distinct from 'cambio_producto'
     or new.status not in ('aprobado', 'cambio_pendiente')
     or coalesce(new.failure_type, '') in ('consulta_pedido', 'cancelar_compra') then
    return new;
  end if;
  -- Sólo la TRANSICIÓN a "cambio aceptado".
  if tg_op = 'UPDATE' and old.resolution is not distinct from 'cambio_producto'
     and old.status in ('aprobado', 'cambio_pendiente') then
    return new;
  end if;

  -- Un instante antes de la transacción: quedan en orden y antes de un texto
  -- libre del admin guardado en la misma operación.
  insert into public.order_claim_messages (claim_id, author_user_id, author_role, message, system_key, created_at)
  values
    (new.id, null, 'admin', 'BEYONIX aceptó el cambio del producto.', 'change_accepted',
     v_now - interval '2 milliseconds'),
    (new.id, null, 'admin',
     'Para continuar, te pedimos que prepares el producto completo, incluyendo caja, bolsas, manuales, accesorios y todos los elementos recibidos, correctamente embalado y en el mejor estado posible. Esto nos permitirá revisar el producto y agilizar el reemplazo.',
     'change_packing_instructions', v_now - interval '1 millisecond')
  on conflict (claim_id, system_key) where system_key is not null do nothing;

  -- Sólo mensajes: aceptar un reclamo NUNCA abre logística. El método
  -- (cambio directo o retiro + revisión) lo elige el Admin explícitamente.
  return new;
end;
$$;

drop trigger if exists zz_order_claim_change_accepted on public.order_claims;
create trigger zz_order_claim_change_accepted
  after insert or update of status, resolution on public.order_claims
  for each row execute function public.order_claim_change_accepted();

-- 6. Método logístico: decisión EXPLÍCITA del Admin -----------------------

-- Abre el tramo pedido, siempre con una sucursal Andreani EXPLÍCITA:
--   * p_branch_id llega verificado por la aplicación contra el catálogo real
--     de Andreani (nunca nombre/dirección del navegador); la base no infiere
--     sucursales por su cuenta.
--   * 'cambio' = Cambio directo; 'devolucion' = Retiro + revisión.
--   * 'reemplazo' = reenvío del plan Retiro + revisión: sólo con el original
--     recibido, inspeccionado y sin incidencias (autorización del Admin).
--   * Cambiar de método con una operación Andreani real ya existente exige
--     un motivo (mínimo 10 caracteres) y queda auditado; sin ella, un tramo
--     pendiente que nunca llegó a Andreani se cancela y queda auditado. Una
--     operación en curso, incierta o heredada abierta bloquea el cambio.
--   * Reclamos legacy (anteriores a este circuito): sólo si nunca tuvieron
--     movimientos logísticos, de stock ni NC; si no, siguen su flujo original.
create or replace function public.request_order_claim_logistics(
  p_claim_id bigint,
  p_actor_id uuid,
  p_direction text,
  p_note text,
  p_branch_id text,
  p_branch_name text,
  p_branch_address text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_open public.order_claim_shipments%rowtype;
  v_leg public.order_claim_shipments%rowtype;
  v_current_plan text;
  v_new_plan text := case p_direction when 'cambio' then 'cambio' else 'retiro' end;
  v_branch_id text := nullif(btrim(coalesce(p_branch_id, '')), '');
  v_note text := btrim(coalesce(p_note, ''));
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_direction not in ('devolucion', 'cambio', 'reemplazo') then raise exception 'CLAIM_SHIPMENT_INVALID'; end if;
  if v_branch_id is null then raise exception 'CLAIM_LOGISTICS_BRANCH_REQUIRED'; end if;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if not public.order_claim_is_accepted(v_claim) then raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED'; end if;
  if p_direction = 'devolucion'
     and v_claim.resolution not in ('cambio_producto', 'reintegro_total', 'reintegro_parcial', 'saldo_a_favor', 'cupon_descuento') then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;
  if p_direction in ('cambio', 'reemplazo') and v_claim.resolution <> 'cambio_producto' then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
     or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and review_required) then
    raise exception 'CLAIM_LOGISTICS_INCIDENT';
  end if;
  -- Legacy: nunca se transforma un reclamo que ya tuvo movimientos.
  if v_claim.logistics_legacy and not exists (select 1 from public.order_claim_units where claim_id = p_claim_id) then
    if exists (select 1 from public.order_replacements where claim_id = p_claim_id)
       or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and status <> 'cancelada')
       or exists (select 1 from public.order_credit_notes where claim_id = p_claim_id and status in ('processing', 'authorized'))
       or exists (
         select 1 from public.inventory_return_movements m
         where m.order_id = v_claim.order_id and m.created_at >= v_claim.created_at
           and m.order_item_id in (select (x->>'order_item_id')::bigint from jsonb_array_elements(v_claim.affected_items) x)
       ) then
      raise exception 'CLAIM_LOGISTICS_LEGACY';
    end if;
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_legacy_opt_in',
      jsonb_build_object('direction', p_direction));
  end if;

  v_current_plan := public.order_claim_logistics_plan(p_claim_id);
  if p_direction = 'reemplazo' then
    -- Nunca antes de la inspección ni fuera del plan Retiro + revisión.
    if v_current_plan is distinct from 'retiro'
       or not exists (select 1 from public.order_claim_shipments
                      where claim_id = p_claim_id and direction = 'devolucion' and status <> 'cancelada' and creation_status = 'created') then
      raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
    end if;
    if not public.order_claim_originals_inspected(p_claim_id) then raise exception 'CLAIM_LOGISTICS_REQUIRES_INSPECTION'; end if;
  elsif v_current_plan is not null and v_current_plan <> v_new_plan and exists (
    select 1 from public.order_claim_shipments
    where claim_id = p_claim_id and status <> 'cancelada' and creation_status in ('processing', 'created', 'manual_review')
  ) then
    -- Ya hubo una operación Andreani real: cambiar de método es un flujo
    -- administrativo explícito, con motivo y auditoría.
    if length(v_note) < 10 then raise exception 'CLAIM_LOGISTICS_PLAN_LOCKED'; end if;
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_plan_changed',
      jsonb_build_object('from', v_current_plan, 'to', v_new_plan, 'notes', left(v_note, 1000)));
  end if;

  select * into v_open from public.order_claim_shipments where claim_id = p_claim_id and closed_at is null
  order by legacy desc, id desc limit 1 for update;
  if found then
    -- Una operación heredada abierta se sigue hasta cerrarse; nunca se reusa.
    if v_open.legacy then raise exception 'CLAIM_LOGISTICS_OPEN'; end if;
    if v_open.direction = p_direction then return v_open; end if;
    if v_open.status <> 'pendiente' or v_open.creation_status not in ('not_started', 'failed') then
      raise exception 'CLAIM_LOGISTICS_OPEN';
    end if;
    update public.order_claim_shipments
    set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_open.id;
    perform public.release_order_claim_leg_units(v_open.id);
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_cancelled',
      jsonb_build_object('shipmentId', v_open.id, 'direction', v_open.direction, 'reason', 'plan_change',
        'notes', left(v_note, 1000)));
  end if;

  v_leg := public.open_order_claim_leg(v_claim, p_direction, p_actor_id, v_branch_id, p_branch_name, p_branch_address);
  if p_direction in ('devolucion', 'cambio') and not exists (
    select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original' and location = 'con_cliente'
  ) then
    raise exception 'CLAIM_LOGISTICS_NOT_NEEDED';
  end if;
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_plan_selected',
    jsonb_build_object('plan', v_new_plan, 'direction', p_direction, 'shipmentId', v_leg.id, 'branchId', v_leg.branch_id,
      'notes', nullif(left(v_note, 1000), '')));
  return v_leg;
end;
$$;

-- Cancela un tramo que nunca existió en Andreani, o uno creado que Andreani
-- anuló / nunca retiró (ninguna unidad salió). Motivo obligatorio.
create or replace function public.cancel_order_claim_leg(
  p_shipment_id bigint,
  p_actor_id uuid,
  p_note text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id bigint;
  v_leg public.order_claim_shipments%rowtype;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  select claim_id into v_claim_id from public.order_claim_shipments where id = p_shipment_id;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  perform 1 from public.order_claims where id = v_claim_id for update;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if v_leg.closed_at is not null then raise exception 'CLAIM_SHIPMENT_CLOSED'; end if;
  if v_leg.creation_status in ('processing', 'manual_review') then raise exception 'CLAIM_SHIPMENT_IN_FLIGHT'; end if;
  if v_leg.creation_status = 'created' and (
    v_leg.status <> 'generada'
    or exists (select 1 from public.order_claim_units where shipment_id = v_leg.id and location not in ('con_cliente', 'reservada'))
  ) then
    raise exception 'CLAIM_SHIPMENT_ALREADY_MOVING';
  end if;

  update public.order_claim_shipments
  set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_leg.id
  returning * into v_leg;
  perform public.release_order_claim_leg_units(v_leg.id);
  perform public.log_order_claim_logistics(v_leg.claim_id, p_actor_id, 'claim_logistics_cancelled',
    jsonb_build_object('shipmentId', v_leg.id, 'direction', v_leg.direction, 'envioId', v_leg.andreani_envio_id,
      'notes', left(btrim(p_note), 1000)));
  return v_leg;
end;
$$;

-- 7. Efectos de un tramo generado (creación o conciliación) ----------------

create or replace function public.order_claim_shipment_created_effects(p_shipment public.order_claim_shipments)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tracking text := coalesce(p_shipment.andreani_tracking, p_shipment.andreani_envio_id);
  v_key text := ':' || p_shipment.id;
  v_branch text := coalesce(nullif(concat_ws(' · ', p_shipment.branch_name, p_shipment.branch_address), ''), 'la sucursal Andreani indicada');
begin
  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (p_shipment.order_id, 'system', 'claim_shipment_created', 'pendiente', 'generada',
    jsonb_build_object('claimId', p_shipment.claim_id, 'shipmentId', p_shipment.id, 'direction', p_shipment.direction,
      'attempt', p_shipment.attempt, 'envioId', p_shipment.andreani_envio_id, 'tracking', p_shipment.andreani_tracking,
      'modality', p_shipment.modality, 'environment', p_shipment.environment, 'costAmount', p_shipment.cost_amount));

  if p_shipment.direction = 'devolucion' then
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'return_generated' || v_key,
      concat_ws(E'\n',
        'Generamos la devolución con Andreani. Descargá la etiqueta desde este reclamo, pegala en el paquete cerrado y llevalo a ' || v_branch || '.',
        'Seguimiento Andreani: ' || v_tracking));
    return;
  end if;

  if p_shipment.direction = 'cambio' then
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'exchange_generated' || v_key,
      concat_ws(E'\n',
        'Generamos el cambio con Andreani. Seguimiento Andreani: ' || v_tracking,
        'Cuando Andreani te avise que el producto nuevo está en ' || v_branch || ', acercate con el producto original completo y embalado y tu DNI: Andreani te entrega el nuevo al recibir el original.',
        'Si no se entrega el producto original, Andreani no entrega el nuevo: queda en la sucursal por un tiempo limitado y después vuelve a BEYONIX.'));
  else
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'replacement_dispatched' || v_key,
      'Revisamos tu producto y te enviamos el reemplazo.');
    perform public.post_order_claim_system_message(p_shipment.claim_id, 'replacement_dispatch_details' || v_key,
      concat_ws(E'\n',
        'Seguimiento Andreani: ' || v_tracking,
        'Retiralo en ' || v_branch || ' cuando Andreani te avise que está disponible; llevá tu DNI.'));
  end if;

  -- Mismos datos que antes se cargaban a mano en el reclamo.
  update public.order_claims
  set replacement_shipping_company = coalesce(replacement_shipping_company, 'Andreani'),
      replacement_tracking = coalesce(replacement_tracking, v_tracking),
      replacement_sent_at = coalesce(replacement_sent_at, now())
  where id = p_shipment.claim_id;
end;
$$;

-- 8. Creación idempotente de la operación Andreani ------------------------

-- Toma el tramo y le asigna sus unidades. Devuelve la fila 'processing' con
-- el token del llamador, la fila ya creada (el llamador la reutiliza) o NULL
-- si otra creación está en curso o requiere conciliación manual.
create or replace function public.claim_order_claim_shipment_creation(
  p_shipment_id bigint,
  p_token uuid,
  p_environment text,
  p_modality text,
  p_contract text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_claim public.order_claims%rowtype;
  v_ready text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_token is null or p_environment not in ('QA', 'PROD') or coalesce(btrim(p_contract), '') = '' or p_modality is null then
    raise exception 'CLAIM_SHIPMENT_INVALID';
  end if;

  select c.* into v_claim from public.order_claims c
  where c.id = (select claim_id from public.order_claim_shipments where id = p_shipment_id)
  for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;

  if v_leg.creation_status = 'created' then return v_leg; end if;
  if v_leg.creation_status in ('processing', 'manual_review') then return null; end if;
  if v_leg.closed_at is not null then raise exception 'CLAIM_SHIPMENT_CLOSED'; end if;
  if not public.order_claim_is_accepted(v_claim)
     or (v_leg.direction in ('cambio', 'reemplazo') and v_claim.resolution <> 'cambio_producto') then
    raise exception 'CLAIM_SHIPMENT_NOT_READY';
  end if;
  v_ready := public.order_claim_leg_readiness(v_leg);
  if v_ready is not null then raise exception '%', v_ready; end if;

  update public.order_claim_shipments
  set creation_status = 'processing',
      creation_token = p_token,
      creation_started_at = clock_timestamp(),
      creation_error = null,
      environment = p_environment,
      modality = p_modality,
      contract = btrim(p_contract),
      updated_at = clock_timestamp()
  where id = v_leg.id
  returning * into v_leg;
  perform public.assign_order_claim_leg_units(v_leg);

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (v_leg.order_id, 'system', 'claim_shipment_creation_started', null, 'processing',
    jsonb_build_object('claimId', v_leg.claim_id, 'shipmentId', v_leg.id, 'direction', v_leg.direction,
      'environment', p_environment, 'modality', p_modality));
  return v_leg;
end;
$$;

-- Guarda la operación creada. Idempotente con el mismo envío; nunca pisa otro.
create or replace function public.complete_order_claim_shipment_creation(
  p_shipment_id bigint,
  p_token uuid,
  p_envio_id text,
  p_tracking text,
  p_estado text,
  p_cost_amount numeric
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if coalesce(btrim(p_envio_id), '') = '' or (p_cost_amount is not null and p_cost_amount < 0) then
    raise exception 'CLAIM_SHIPMENT_INVALID';
  end if;

  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if v_leg.creation_status = 'created' then
    if v_leg.andreani_envio_id = btrim(p_envio_id) then return v_leg; end if;
    raise exception 'CLAIM_SHIPMENT_ALREADY_CREATED';
  end if;
  if v_leg.creation_status is distinct from 'processing' or v_leg.creation_token is distinct from p_token then
    raise exception 'CLAIM_SHIPMENT_NOT_CLAIMED';
  end if;
  if exists (select 1 from public.ordenes where andreani_envio_id = btrim(p_envio_id)) then
    raise exception 'CLAIM_SHIPMENT_ENVIO_IN_USE';
  end if;

  update public.order_claim_shipments
  set creation_status = 'created',
      status = 'generada',
      creation_token = null,
      creation_error = null,
      andreani_envio_id = btrim(p_envio_id),
      andreani_tracking = nullif(btrim(coalesce(p_tracking, '')), ''),
      andreani_estado = nullif(btrim(coalesce(p_estado, '')), ''),
      cost_amount = p_cost_amount,
      updated_at = clock_timestamp()
  where id = v_leg.id
  returning * into v_leg;

  perform public.order_claim_shipment_created_effects(v_leg);
  return v_leg;
end;
$$;

-- Registra un intento fallido o una creación bloqueada.
--   blocked       -> configuración/validación ANTES de tomar el tramo (sin
--                    token; sólo deja el motivo visible).
--   failed        -> Andreani NO creó la operación (rechazo explícito o error
--                    antes del POST): se puede reintentar; libera unidades.
--   manual_review -> resultado desconocido (timeout/5xx/409/respuesta
--                    inválida): Andreani pudo haberla creado; no se reintenta.
create or replace function public.fail_order_claim_shipment_creation(
  p_shipment_id bigint,
  p_token uuid,
  p_error text,
  p_outcome text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_message text := left(coalesce(nullif(btrim(p_error), ''), 'No se pudo generar el envío Andreani.'), 500);
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_outcome not in ('blocked', 'failed', 'manual_review') then raise exception 'CLAIM_SHIPMENT_INVALID'; end if;

  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;

  if p_outcome = 'blocked' then
    if v_leg.closed_at is not null or v_leg.creation_status not in ('not_started', 'failed') then return v_leg; end if;
    update public.order_claim_shipments
    set creation_error = v_message, updated_at = clock_timestamp()
    where id = v_leg.id returning * into v_leg;
    return v_leg;
  end if;

  if v_leg.creation_status is distinct from 'processing' or v_leg.creation_token is distinct from p_token then
    return v_leg;
  end if;
  update public.order_claim_shipments
  set creation_status = p_outcome,
      creation_token = null,
      creation_error = v_message,
      updated_at = clock_timestamp()
  where id = v_leg.id
  returning * into v_leg;
  if p_outcome = 'failed' then perform public.release_order_claim_leg_units(v_leg.id); end if;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (v_leg.order_id, 'system', 'claim_shipment_creation_failed', 'processing', p_outcome,
    jsonb_build_object('claimId', v_leg.claim_id, 'shipmentId', v_leg.id, 'direction', v_leg.direction, 'error', v_message));
  if p_outcome = 'manual_review' then
    update public.order_claims set admin_needs_action = true
    where id = v_leg.claim_id and status not in ('cerrado', 'rechazado');
  end if;
  return v_leg;
end;
$$;

-- Conciliación (sólo admin/super_admin, con nota): después de un resultado
-- incierto. 'created' se verifica antes contra Andreani (lado aplicación) y
-- nunca vincula una orden usada por otro tramo o por un pedido de venta.
create or replace function public.resolve_order_claim_shipment_reconciliation(
  p_shipment_id bigint,
  p_actor_id uuid,
  p_resolution text,
  p_envio_id text,
  p_tracking text,
  p_notes text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_previous text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = p_actor_id and rol in ('admin', 'super_admin')) then
    raise exception 'CLAIM_SHIPMENT_RECONCILIATION_FORBIDDEN';
  end if;
  if p_resolution not in ('created', 'not_created') or length(btrim(coalesce(p_notes, ''))) < 5
     or (p_resolution = 'created' and coalesce(btrim(p_envio_id), '') = '') then
    raise exception 'CLAIM_SHIPMENT_INVALID';
  end if;

  perform 1 from public.order_claims
  where id = (select claim_id from public.order_claim_shipments where id = p_shipment_id) for update;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  -- Sólo un resultado incierto, o una toma colgada (el proceso murió).
  if not (v_leg.creation_status = 'manual_review'
          or (v_leg.creation_status = 'processing' and v_leg.creation_started_at < clock_timestamp() - interval '10 minutes')) then
    raise exception 'CLAIM_SHIPMENT_RECONCILIATION_NOT_PENDING';
  end if;
  v_previous := v_leg.creation_status;

  if p_resolution = 'not_created' then
    update public.order_claim_shipments
    set creation_status = 'failed', creation_token = null,
        creation_error = 'Conciliado: Andreani no creó la operación. Se puede volver a generar.',
        updated_at = clock_timestamp()
    where id = v_leg.id returning * into v_leg;
    perform public.release_order_claim_leg_units(v_leg.id);
  else
    if exists (select 1 from public.ordenes where andreani_envio_id = btrim(p_envio_id)) then
      raise exception 'CLAIM_SHIPMENT_ENVIO_IN_USE';
    end if;
    update public.order_claim_shipments
    set creation_status = 'created', status = 'generada', creation_token = null, creation_error = null,
        andreani_envio_id = btrim(p_envio_id),
        andreani_tracking = coalesce(nullif(btrim(coalesce(p_tracking, '')), ''), btrim(p_envio_id)),
        updated_at = clock_timestamp()
    where id = v_leg.id returning * into v_leg;
    perform public.order_claim_shipment_created_effects(v_leg);
  end if;

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (v_leg.order_id, 'admin', p_actor_id, 'claim_shipment_reconciled', v_previous, v_leg.creation_status,
    jsonb_build_object('claimId', v_leg.claim_id, 'shipmentId', v_leg.id, 'direction', v_leg.direction,
      'resolution', p_resolution, 'envioId', v_leg.andreani_envio_id, 'notes', left(btrim(p_notes), 1000)));
  return v_leg;
end;
$$;

-- 9. Tracking: avance monotónico y efectos únicos --------------------------

create or replace function public.order_claim_leg_progress_effects(
  p_leg public.order_claim_shipments,
  p_previous_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := ':' || p_leg.id;
  v_moved integer;
begin
  -- Andreani ya tiene la unidad que viaja en este tramo.
  if public.order_claim_leg_rank(p_leg.status) >= 2 then
    if p_leg.direction = 'devolucion' then
      update public.order_claim_units set location = 'en_andreani', updated_at = clock_timestamp()
      where shipment_id = p_leg.id and role = 'original' and location = 'con_cliente';
    else
      update public.order_claim_units set location = 'en_andreani', updated_at = clock_timestamp()
      where shipment_id = p_leg.id and role = 'reemplazo' and location = 'reservada';
    end if;
  end if;

  if p_leg.direction = 'cambio' and p_leg.status = 'en_sucursal' and p_leg.exchange_outcome is null then
    perform public.post_order_claim_system_message(p_leg.claim_id, 'exchange_at_branch' || v_key,
      'Tu producto nuevo está disponible temporalmente en la sucursal Andreani. Acercate con el producto original completo y embalado y tu DNI para hacer el cambio. Si no se retira, vuelve a BEYONIX.');
  end if;

  if p_leg.status <> 'entregada' or p_previous_status = 'entregada' then return; end if;

  if p_leg.direction = 'devolucion' then
    perform public.post_order_claim_system_message(p_leg.claim_id, 'return_delivered' || v_key,
      'Andreani informó que tu producto llegó a BEYONIX. Vamos a revisarlo y te avisaremos por este medio cómo sigue.', true);
  elsif p_leg.direction = 'reemplazo' then
    update public.order_claim_units set location = 'entregada_cliente', updated_at = clock_timestamp()
    where shipment_id = p_leg.id and role = 'reemplazo' and location in ('reservada', 'en_andreani');
    get diagnostics v_moved = row_count;
    if v_moved > 0 then
      perform public.post_order_claim_system_message(p_leg.claim_id, 'replacement_delivered' || v_key,
        'Andreani informó que tu producto de reemplazo fue entregado.', true);
    end if;
  else
    -- Cambio: Andreani entrega el nuevo SÓLO si recibe el original.
    update public.order_claim_units set location = 'entregada_cliente', updated_at = clock_timestamp()
    where shipment_id = p_leg.id and role = 'reemplazo' and location in ('reservada', 'en_andreani');
    get diagnostics v_moved = row_count;
    if v_moved > 0 then
      update public.order_claim_units set location = 'en_andreani', updated_at = clock_timestamp()
      where shipment_id = p_leg.id and role = 'original' and location = 'con_cliente';
      update public.order_claim_shipments set exchange_outcome = 'completado', updated_at = clock_timestamp()
      where id = p_leg.id;
      perform public.post_order_claim_system_message(p_leg.claim_id, 'exchange_completed' || v_key,
        'Andreani informó que el cambio se completó: te entregó el producto nuevo y retiró el original. Cuando el original llegue a BEYONIX lo revisamos y te avisamos.', true);
    else
      -- El producto nuevo ya fue recibido de vuelta en BEYONIX: un "entregado"
      -- posterior no cambia nada físico; queda para revisión del Admin.
      update public.order_claims set admin_needs_action = true
      where id = p_leg.claim_id and status not in ('cerrado', 'rechazado');
      perform public.log_order_claim_logistics(p_leg.claim_id, null, 'claim_shipment_event_after_reception',
        jsonb_build_object('shipmentId', p_leg.id, 'event', p_leg.andreani_last_event));
    end if;
  end if;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (p_leg.order_id, 'system', 'claim_shipment_delivered', p_previous_status, 'entregada',
    jsonb_build_object('claimId', p_leg.claim_id, 'shipmentId', p_leg.id, 'direction', p_leg.direction,
      'envioId', p_leg.andreani_envio_id, 'tracking', p_leg.andreani_tracking, 'event', p_leg.andreani_last_event));
end;
$$;

-- p_phase: máximo avance observado en TODOS los eventos (no el último), así
-- eventos repetidos o desordenados nunca hacen retroceder. p_incident: el
-- evento más reciente es una novedad (no entregado, nueva fecha...), que se
-- limpia sola con un evento posterior. p_review_event: un evento que no se
-- puede clasificar con seguridad para el reclamo (anulación, siniestro,
-- rescate, cambio de destino, fuera del maestro...): se guarda, pide revisión
-- del Admin y CONGELA el avance (ni estado, ni unidades, ni cierre) hasta que
-- se resuelva de forma explícita y auditada. Nunca toca stock.
create or replace function public.apply_order_claim_shipment_tracking(
  p_shipment_id bigint,
  p_phase text,
  p_incident boolean,
  p_estado text,
  p_tracking text,
  p_last_event text,
  p_last_event_at timestamptz,
  p_custody_since timestamptz,
  p_review_event text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_previous public.order_claim_shipments%rowtype;
  v_next text;
  v_stale boolean;
  v_review text := nullif(btrim(coalesce(p_review_event, '')), '');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_phase not in ('sin_cambio', 'en_transito', 'en_sucursal', 'entregada') then raise exception 'CLAIM_SHIPMENT_INVALID'; end if;

  perform 1 from public.order_claims
  where id = (select claim_id from public.order_claim_shipments where id = p_shipment_id) for update;
  select * into v_previous from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if v_previous.creation_status is distinct from 'created' then raise exception 'CLAIM_SHIPMENT_NOT_CREATED'; end if;
  if v_previous.status = 'cancelada' then return v_previous; end if;
  if v_review is not null and v_review = any (v_previous.review_acknowledged) then v_review := null; end if;

  v_stale := p_last_event_at is not null and v_previous.andreani_last_event_at is not null
    and p_last_event_at < v_previous.andreani_last_event_at;
  v_next := case when p_phase = 'sin_cambio' then v_previous.status else p_phase end;
  if public.order_claim_leg_rank(v_next) <= public.order_claim_leg_rank(v_previous.status)
     or v_previous.review_required or v_review is not null then
    v_next := v_previous.status;
  end if;

  update public.order_claim_shipments
  set status = v_next,
      delivered_at = case when v_next = 'entregada' and delivered_at is null then clock_timestamp() else delivered_at end,
      incident_open = case
        when v_stale then incident_open
        when coalesce(p_incident, false) then true
        when v_next <> v_previous.status or p_last_event_at is not null then false
        else incident_open end,
      incident_event = case when not v_stale and coalesce(p_incident, false) then nullif(btrim(coalesce(p_last_event, '')), '') else incident_event end,
      incident_at = case when not v_stale and coalesce(p_incident, false) then coalesce(p_last_event_at, clock_timestamp()) else incident_at end,
      review_required = review_required or v_review is not null,
      review_event = case when v_review is not null and not review_required then v_review else review_event end,
      review_at = case when v_review is not null and not review_required then clock_timestamp() else review_at end,
      andreani_estado = case when v_stale then andreani_estado else coalesce(nullif(btrim(coalesce(p_estado, '')), ''), andreani_estado) end,
      andreani_tracking = coalesce(andreani_tracking, nullif(btrim(coalesce(p_tracking, '')), '')),
      andreani_last_event = case when v_stale then andreani_last_event else coalesce(nullif(btrim(coalesce(p_last_event, '')), ''), andreani_last_event) end,
      andreani_last_event_at = case when v_stale then andreani_last_event_at else coalesce(p_last_event_at, andreani_last_event_at) end,
      branch_custody_since = coalesce(branch_custody_since, case when v_next = 'en_sucursal' then p_custody_since end),
      last_checked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = v_previous.id
  returning * into v_leg;

  if v_next <> v_previous.status then
    perform public.order_claim_leg_progress_effects(v_leg, v_previous.status);
    if v_next = 'entregada' and v_leg.direction in ('devolucion', 'reemplazo') then
      update public.order_claim_shipments set closed_at = coalesce(closed_at, clock_timestamp()) where id = v_leg.id;
    end if;
    v_leg := public.refresh_order_claim_leg_closure(v_leg.id);
  end if;

  if v_leg.review_required and not v_previous.review_required then
    update public.order_claims set admin_needs_action = true
    where id = v_leg.claim_id and status not in ('cerrado', 'rechazado');
    perform public.log_order_claim_logistics(v_leg.claim_id, null, 'claim_shipment_review_required',
      jsonb_build_object('shipmentId', v_leg.id, 'event', v_leg.review_event, 'phase', p_phase));
  elsif v_leg.incident_open and not v_previous.incident_open then
    update public.order_claims set admin_needs_action = true
    where id = v_leg.claim_id and status not in ('cerrado', 'rechazado');
    perform public.log_order_claim_logistics(v_leg.claim_id, null, 'claim_shipment_incident',
      jsonb_build_object('shipmentId', v_leg.id, 'event', v_leg.incident_event, 'at', v_leg.incident_at));
  end if;

  select * into v_leg from public.order_claim_shipments where id = v_leg.id;
  return v_leg;
end;
$$;

-- Respuesta de seguimiento que no se pudo interpretar (evento fuera del
-- maestro documentado, formato inválido): se registra y pide revisión, sin
-- cambiar nada más. Idempotente.
create or replace function public.flag_order_claim_shipment_review(
  p_shipment_id bigint,
  p_event text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
  v_event text := left(coalesce(nullif(btrim(p_event), ''), 'Respuesta de seguimiento no interpretable'), 200);
begin
  if auth.role() is distinct from 'service_role' then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if v_leg.review_required or v_event = any (v_leg.review_acknowledged) or v_leg.status = 'cancelada' then
    update public.order_claim_shipments set last_checked_at = clock_timestamp() where id = v_leg.id returning * into v_leg;
    return v_leg;
  end if;
  update public.order_claim_shipments
  set review_required = true, review_event = v_event, review_at = clock_timestamp(),
      last_checked_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = v_leg.id returning * into v_leg;
  update public.order_claims set admin_needs_action = true
  where id = v_leg.claim_id and status not in ('cerrado', 'rechazado');
  perform public.log_order_claim_logistics(v_leg.claim_id, null, 'claim_shipment_review_required',
    jsonb_build_object('shipmentId', v_leg.id, 'event', v_event));
  return v_leg;
end;
$$;

-- Resolución manual auditada de un evento no clasificable: el Admin confirma
-- con Andreani qué pasó y lo registra. El evento queda reconocido (no vuelve a
-- frenar) y el avance se reanuda en la próxima consulta; los hechos físicos se
-- siguen registrando con sus acciones propias (llegada, cancelación...).
create or replace function public.resolve_order_claim_shipment_review(
  p_shipment_id bigint,
  p_actor_id uuid,
  p_note text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  perform 1 from public.order_claims
  where id = (select claim_id from public.order_claim_shipments where id = p_shipment_id) for update;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  if not v_leg.review_required then return v_leg; end if;
  update public.order_claim_shipments
  set review_required = false,
      review_acknowledged = case when review_event = any (review_acknowledged) then review_acknowledged
                                 else array_append(review_acknowledged, review_event) end,
      updated_at = clock_timestamp()
  where id = v_leg.id returning * into v_leg;
  perform public.log_order_claim_logistics(v_leg.claim_id, p_actor_id, 'claim_shipment_review_resolved',
    jsonb_build_object('shipmentId', v_leg.id, 'event', v_leg.review_event, 'notes', left(btrim(p_note), 1000)));
  return v_leg;
end;
$$;

-- 10. Cambio no completado (cliente no entregó el original) --------------

create or replace function public.mark_order_claim_exchange_not_completed(
  p_shipment_id bigint,
  p_actor_id uuid,
  p_note text
)
returns public.order_claim_shipments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_leg public.order_claim_shipments%rowtype;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  perform 1 from public.order_claims
  where id = (select claim_id from public.order_claim_shipments where id = p_shipment_id) for update;
  select * into v_leg from public.order_claim_shipments where id = p_shipment_id for update;
  if not found then raise exception 'CLAIM_SHIPMENT_NOT_FOUND'; end if;
  -- El producto nuevo tiene que estar en manos de Andreani.
  if v_leg.direction <> 'cambio' or v_leg.creation_status <> 'created' or v_leg.exchange_outcome is not null
     or v_leg.closed_at is not null or v_leg.status not in ('en_transito', 'en_sucursal') then
    raise exception 'CLAIM_EXCHANGE_STATE';
  end if;

  update public.order_claim_shipments
  set exchange_outcome = 'no_completado', updated_at = clock_timestamp()
  where id = v_leg.id returning * into v_leg;
  update public.order_claim_units set location = 'en_andreani', updated_at = clock_timestamp()
  where shipment_id = v_leg.id and role = 'reemplazo' and location = 'reservada';

  perform public.post_order_claim_system_message(v_leg.claim_id, 'exchange_not_completed:' || v_leg.id,
    'El cambio no se pudo completar porque no se entregó el producto original. El producto nuevo queda temporalmente en la sucursal Andreani y después vuelve a BEYONIX. Si todavía querés hacer el cambio, escribinos por este medio.');
  perform public.log_order_claim_logistics(v_leg.claim_id, p_actor_id, 'claim_exchange_not_completed',
    jsonb_build_object('shipmentId', v_leg.id, 'notes', left(btrim(p_note), 1000)));
  return v_leg;
end;
$$;

-- 11. Recepción física en BEYONIX (sin tocar stock) ----------------------

-- Las unidades llegan a BEYONIX y quedan PENDIENTES DE INSPECCIÓN: la llegada
-- del paquete no valida el producto. p_incident_type registra lo observado al
-- abrirlo (producto distinto, cantidad incorrecta, faltantes/accesorios,
-- paquete vacío, daño/estado); NULL = sin novedad al recibir. Para un
-- reemplazo, sólo desde Andreani; "entregada_cliente" se admite como
-- CORRECCIÓN (Andreani informó entregado pero el producto volvió), con nota.
create or replace function public.register_order_claim_units_arrival(
  p_claim_id bigint,
  p_actor_id uuid,
  p_role text,
  p_order_item_id bigint,
  p_quantity integer,
  p_note text,
  p_incident_type text,
  p_idempotency_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_ids bigint[];
  v_corrected integer;
  v_leg record;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_role not in ('original', 'reemplazo') or p_quantity is null or p_quantity <= 0 then
    raise exception 'CLAIM_LOGISTICS_INVALID';
  end if;
  if p_incident_type is not null and (
    p_incident_type not in ('producto_distinto', 'cantidad_incorrecta', 'faltantes_accesorios', 'paquete_vacio', 'dano_estado', 'otro')
    or length(btrim(coalesce(p_note, ''))) < 5) then
    raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED';
  end if;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.status in ('cerrado', 'rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
  if not public.begin_order_claim_unit_event(p_claim_id, p_idempotency_key, 'arrival:' || p_role, p_actor_id,
    jsonb_build_object('orderItemId', p_order_item_id, 'quantity', p_quantity, 'incidentType', p_incident_type,
      'notes', left(btrim(coalesce(p_note, '')), 1000))) then
    return 0;
  end if;

  select array_agg(id order by prio, id) into v_ids from (
    select id, case location when 'en_andreani' then 0 when 'con_cliente' then 1 else 2 end prio
    from public.order_claim_units
    where claim_id = p_claim_id and role = p_role and order_item_id = p_order_item_id
      and location = any (case p_role when 'original' then array['en_andreani', 'con_cliente'] else array['en_andreani', 'entregada_cliente'] end)
    order by prio, id
    limit p_quantity
    for update
  ) picked;
  if coalesce(array_length(v_ids, 1), 0) < p_quantity then raise exception 'CLAIM_UNITS_NOT_AVAILABLE'; end if;

  select count(*) into v_corrected from public.order_claim_units where id = any (v_ids) and location = 'entregada_cliente';
  if v_corrected > 0 and length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;

  -- Corrección: el "entregado" de Andreani no fue un cambio real. El original
  -- nunca salió del cliente.
  for v_leg in
    select distinct s.id, s.exchange_outcome from public.order_claim_units u
    join public.order_claim_shipments s on s.id = u.shipment_id
    where u.id = any (v_ids) and u.location = 'entregada_cliente' and s.direction = 'cambio'
  loop
    update public.order_claim_shipments set exchange_outcome = 'no_completado', updated_at = clock_timestamp()
    where id = v_leg.id;
    update public.order_claim_units set location = 'con_cliente', updated_at = clock_timestamp()
    where shipment_id = v_leg.id and role = 'original' and location = 'en_andreani';
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_exchange_outcome_corrected',
      jsonb_build_object('shipmentId', v_leg.id, 'previousOutcome', v_leg.exchange_outcome, 'notes', left(btrim(p_note), 1000)));
  end loop;

  update public.order_claim_units
  set location = 'recibida_beyonix',
      incident_open = incident_open or p_incident_type is not null,
      incident_type = coalesce(p_incident_type, incident_type),
      incident_note = case when p_incident_type is not null
        then left(concat_ws(E'\n', incident_note, btrim(p_note)), 2000) else incident_note end,
      updated_at = clock_timestamp()
  where id = any (v_ids);

  if p_role = 'original' then
    perform public.post_order_claim_system_message(p_claim_id, 'original_received',
      'Recibimos tu producto en BEYONIX. Lo vamos a revisar y te avisaremos por este medio cómo sigue.');
  else
    for v_leg in
      select distinct s.id, s.direction, s.exchange_outcome from public.order_claim_units u
      join public.order_claim_shipments s on s.id = u.shipment_id where u.id = any (v_ids)
    loop
      if v_leg.direction = 'cambio' and v_leg.exchange_outcome is null then
        update public.order_claim_shipments set exchange_outcome = 'no_completado', updated_at = clock_timestamp()
        where id = v_leg.id;
      end if;
      perform public.post_order_claim_system_message(p_claim_id, 'replacement_returned:' || v_leg.id,
        case when v_leg.direction = 'cambio'
          then 'El producto nuevo volvió a BEYONIX porque el cambio no se completó. Te vamos a escribir por este medio para definir cómo seguimos.'
          else 'El producto de reemplazo volvió a BEYONIX porque Andreani no pudo entregarlo. Te vamos a escribir por este medio para definir cómo seguimos.'
        end);
      perform public.refresh_order_claim_leg_closure(v_leg.id);
    end loop;
  end if;
  for v_leg in select distinct shipment_id id from public.order_claim_units where id = any (v_ids) and shipment_id is not null loop
    perform public.refresh_order_claim_leg_closure(v_leg.id);
  end loop;

  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_units_received',
    jsonb_build_object('role', p_role, 'orderItemId', p_order_item_id, 'quantity', p_quantity,
      'unitIds', to_jsonb(v_ids), 'incidentType', p_incident_type, 'notes', left(btrim(coalesce(p_note, '')), 1000)));
  if p_incident_type is not null then
    update public.order_claims set admin_needs_action = true where id = p_claim_id;
  end if;
  return p_quantity;
end;
$$;

-- 12. Inspección del ORIGINAL: la recepción canónica de stock ----------
-- (process_claim_return_inventory / record_order_item_return_reception, y
-- también la NC) escribe inventory_return_movements. Este trigger lleva las
-- unidades del reclamo activo a su destino final en la misma transacción.

create or replace function public.apply_return_movement_to_claim_units()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id bigint;
  v_ok integer := coalesce(new.sellable_quantity, 0) + coalesce(new.discounted_quantity, 0);
  v_total integer := coalesce(new.sellable_quantity, 0) + coalesce(new.discounted_quantity, 0) + coalesce(new.non_sellable_quantity, 0);
  v_leg record;
begin
  if new.order_item_id is null or v_total <= 0 then return new; end if;
  select c.id into v_claim_id from public.order_claims c
  where c.order_id = new.order_id and c.status not in ('cerrado', 'rechazado')
    and exists (select 1 from public.order_claim_units u
                where u.claim_id = c.id and u.role = 'original' and u.order_item_id = new.order_item_id
                  and u.location in ('recibida_beyonix', 'en_andreani', 'con_cliente'))
  order by c.id desc
  limit 1;
  if v_claim_id is null then return new; end if;

  -- Las unidades que vuelven a stock son las que no tienen una incidencia
  -- que las excluya (guard_return_movement_claim_units ya lo validó).
  with picked as (
    select id, coalesce(incident_type in ('paquete_vacio', 'producto_distinto'), false) bad,
      row_number() over (order by case location when 'recibida_beyonix' then 0 when 'en_andreani' then 1 else 2 end, id) rn
    from public.order_claim_units
    where claim_id = v_claim_id and role = 'original' and order_item_id = new.order_item_id
      and location in ('recibida_beyonix', 'en_andreani', 'con_cliente')
  ), chosen as (
    select id, row_number() over (order by bad, rn) k from picked where rn <= v_total
  )
  update public.order_claim_units u
  set location = case when chosen.k <= v_ok then 'reincorporada_stock' else 'baja' end,
      updated_at = clock_timestamp()
  from chosen
  where u.id = chosen.id;

  for v_leg in
    select distinct shipment_id id from public.order_claim_units
    where claim_id = v_claim_id and role = 'original' and order_item_id = new.order_item_id and shipment_id is not null
  loop
    perform public.refresh_order_claim_leg_closure(v_leg.id);
  end loop;
  perform public.log_order_claim_logistics(v_claim_id, null, 'claim_units_inspected',
    jsonb_build_object('role', 'original', 'orderItemId', new.order_item_id, 'restocked', v_ok,
      'writtenOff', v_total - v_ok, 'sourceKey', new.source_key));
  return new;
end;
$$;

drop trigger if exists zz_apply_return_movement_to_claim_units on public.inventory_return_movements;
create trigger zz_apply_return_movement_to_claim_units
  after insert on public.inventory_return_movements
  for each row execute function public.apply_return_movement_to_claim_units();

-- Antes de mover stock: un paquete vacío o un producto distinto NUNCA vuelve
-- a stock vendible (ni con descuento). Se permite registrarlo como baja.
create or replace function public.guard_return_movement_claim_units()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id bigint;
  v_ok integer := coalesce(new.sellable_quantity, 0) + coalesce(new.discounted_quantity, 0);
  v_total integer := coalesce(new.sellable_quantity, 0) + coalesce(new.discounted_quantity, 0) + coalesce(new.non_sellable_quantity, 0);
  v_bad integer;
begin
  if new.order_item_id is null or v_ok <= 0 then return new; end if;
  select c.id into v_claim_id from public.order_claims c
  where c.order_id = new.order_id and c.status not in ('cerrado', 'rechazado')
    and exists (select 1 from public.order_claim_units u
                where u.claim_id = c.id and u.role = 'original' and u.order_item_id = new.order_item_id
                  and u.location in ('recibida_beyonix', 'en_andreani', 'con_cliente'))
  order by c.id desc
  limit 1;
  if v_claim_id is null then return new; end if;
  select count(*) filter (where incident_type in ('paquete_vacio', 'producto_distinto')) into v_bad
  from (
    select incident_type from public.order_claim_units
    where claim_id = v_claim_id and role = 'original' and order_item_id = new.order_item_id
      and location in ('recibida_beyonix', 'en_andreani', 'con_cliente')
    order by case location when 'recibida_beyonix' then 0 when 'en_andreani' then 1 else 2 end, id
    limit v_total
  ) picked;
  if v_ok > v_total - v_bad then raise exception 'CLAIM_INSPECTION_NOT_RESTOCKABLE'; end if;
  return new;
end;
$$;

drop trigger if exists aa_guard_return_movement_claim_units on public.inventory_return_movements;
create trigger aa_guard_return_movement_claim_units
  before insert on public.inventory_return_movements
  for each row execute function public.guard_return_movement_claim_units();

-- 13. Reemplazo: devuelto, liberado, entregado a mano -------------------

-- Reingresa (stock vendible) o da de baja unidades de reemplazo; siempre con
-- el motor canónico de stock y una clave idempotente por variante.
create or replace function public.settle_order_claim_replacement_units(
  p_claim_id bigint,
  p_actor_id uuid,
  p_unit_ids bigint[],
  p_restock integer,
  p_key text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_stock integer;
begin
  -- Reingreso por variante (lock de producto: el mismo que todo el stock).
  for v_row in
    select r.replacement_variant_id variant_id, v.producto_id, count(*)::integer n
    from (select x.id, c.replacement_id, x.rn from unnest(p_unit_ids) with ordinality as x(id, rn) join public.order_claim_units c on c.id = x.id) u
    join public.order_replacements r on r.id = u.replacement_id
    join public.producto_variantes v on v.id = r.replacement_variant_id
    where u.rn <= p_restock
    group by r.replacement_variant_id, v.producto_id
    order by r.replacement_variant_id
  loop
    perform pg_advisory_xact_lock(93000, v_row.producto_id::integer);
    select stock into v_stock from public.producto_variantes where id = v_row.variant_id;
    perform public.adjust_variant_stock_idempotent(
      v_row.variant_id, coalesce(v_stock, 0) + v_row.n, p_reason, p_actor_id,
      'claim-replacement:' || p_key || ':' || v_row.variant_id);
  end loop;

  update public.order_replacements r
  set reverted_quantity = r.reverted_quantity + x.n
  from (select replacement_id, count(*)::integer n from public.order_claim_units where id = any (p_unit_ids) group by replacement_id) x
  where r.id = x.replacement_id;

  update public.order_claim_units u
  set location = case when picked.rn <= p_restock then 'reincorporada_stock' else 'baja' end,
      updated_at = clock_timestamp()
  from (select x.id, x.rn from unnest(p_unit_ids) with ordinality as x(id, rn)) picked
  where u.id = picked.id;
end;
$$;

create or replace function public.inspect_order_claim_replacement_units(
  p_claim_id bigint,
  p_actor_id uuid,
  p_order_item_id bigint,
  p_restock integer,
  p_write_off integer,
  p_note text,
  p_idempotency_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_ids bigint[];
  v_bad integer;
  v_total integer := coalesce(p_restock, 0) + coalesce(p_write_off, 0);
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_restock is null or p_write_off is null or p_restock < 0 or p_write_off < 0 or v_total <= 0 then
    raise exception 'CLAIM_LOGISTICS_INVALID';
  end if;
  if p_write_off > 0 and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if v_claim.status in ('cerrado', 'rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
  if not public.begin_order_claim_unit_event(p_claim_id, p_idempotency_key, 'inspect:reemplazo', p_actor_id,
    jsonb_build_object('orderItemId', p_order_item_id, 'restock', p_restock, 'writeOff', p_write_off,
      'notes', left(btrim(coalesce(p_note, '')), 1000))) then
    return 0;
  end if;

  -- Primero las sanas: el paquete vacío / producto distinto nunca vuelve a stock.
  select array_agg(id order by bad, id), count(*) filter (where bad) into v_ids, v_bad from (
    select id, coalesce(incident_type in ('paquete_vacio', 'producto_distinto'), false) bad from public.order_claim_units
    where claim_id = p_claim_id and role = 'reemplazo' and order_item_id = p_order_item_id and location = 'recibida_beyonix'
    order by coalesce(incident_type in ('paquete_vacio', 'producto_distinto'), false), id limit v_total for update
  ) picked;
  if coalesce(array_length(v_ids, 1), 0) < v_total then raise exception 'CLAIM_UNITS_NOT_AVAILABLE'; end if;
  if p_restock > v_total - coalesce(v_bad, 0) then raise exception 'CLAIM_INSPECTION_NOT_RESTOCKABLE'; end if;

  perform public.settle_order_claim_replacement_units(p_claim_id, p_actor_id, v_ids, p_restock, p_idempotency_key,
    'Reingreso de reemplazo devuelto (reclamo #' || p_claim_id || ')');
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_units_inspected',
    jsonb_build_object('role', 'reemplazo', 'orderItemId', p_order_item_id, 'restocked', p_restock,
      'writtenOff', p_write_off, 'unitIds', to_jsonb(v_ids), 'notes', left(btrim(coalesce(p_note, '')), 1000)));
  return v_total;
end;
$$;

-- Reserva que nunca salió (sin tramo o con tramo cancelado): vuelve al stock
-- vendible. Motivo obligatorio.
create or replace function public.release_order_claim_replacement_reservation(
  p_claim_id bigint,
  p_actor_id uuid,
  p_order_item_id bigint,
  p_quantity integer,
  p_note text,
  p_idempotency_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[];
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'CLAIM_LOGISTICS_INVALID'; end if;
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  perform 1 from public.order_claims where id = p_claim_id and status not in ('cerrado', 'rechazado') for update;
  if not found then raise exception 'CLAIM_TERMINAL'; end if;
  if not public.begin_order_claim_unit_event(p_claim_id, p_idempotency_key, 'release:reemplazo', p_actor_id,
    jsonb_build_object('orderItemId', p_order_item_id, 'quantity', p_quantity, 'notes', left(btrim(p_note), 1000))) then
    return 0;
  end if;

  select array_agg(id order by id) into v_ids from (
    select id from public.order_claim_units
    where claim_id = p_claim_id and role = 'reemplazo' and order_item_id = p_order_item_id
      and location = 'reservada' and shipment_id is null
    order by id desc limit p_quantity for update
  ) picked;
  if coalesce(array_length(v_ids, 1), 0) < p_quantity then raise exception 'CLAIM_UNITS_NOT_AVAILABLE'; end if;

  perform public.settle_order_claim_replacement_units(p_claim_id, p_actor_id, v_ids, p_quantity, p_idempotency_key,
    'Reserva de reemplazo liberada (reclamo #' || p_claim_id || ')');
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_replacement_reservation_released',
    jsonb_build_object('orderItemId', p_order_item_id, 'quantity', p_quantity, 'unitIds', to_jsonb(v_ids),
      'notes', left(btrim(p_note), 1000)));
  return p_quantity;
end;
$$;

-- Entrega fuera de Andreani (en mano / otro transporte). Salida de recuperación
-- auditada; nunca para unidades que viajan en un tramo Andreani.
create or replace function public.confirm_order_claim_replacement_delivered_manually(
  p_claim_id bigint,
  p_actor_id uuid,
  p_order_item_id bigint,
  p_quantity integer,
  p_note text,
  p_idempotency_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[];
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'CLAIM_LOGISTICS_INVALID'; end if;
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  perform 1 from public.order_claims where id = p_claim_id and status not in ('cerrado', 'rechazado') for update;
  if not found then raise exception 'CLAIM_TERMINAL'; end if;
  if not public.begin_order_claim_unit_event(p_claim_id, p_idempotency_key, 'manual_delivery:reemplazo', p_actor_id,
    jsonb_build_object('orderItemId', p_order_item_id, 'quantity', p_quantity, 'notes', left(btrim(p_note), 1000))) then
    return 0;
  end if;
  select array_agg(id order by id) into v_ids from (
    select id from public.order_claim_units
    where claim_id = p_claim_id and role = 'reemplazo' and order_item_id = p_order_item_id
      and location = 'reservada' and shipment_id is null
    order by id limit p_quantity for update
  ) picked;
  if coalesce(array_length(v_ids, 1), 0) < p_quantity then raise exception 'CLAIM_UNITS_NOT_AVAILABLE'; end if;
  update public.order_claim_units set location = 'entregada_cliente', updated_at = clock_timestamp() where id = any (v_ids);
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_replacement_delivered_manually',
    jsonb_build_object('orderItemId', p_order_item_id, 'quantity', p_quantity, 'unitIds', to_jsonb(v_ids),
      'notes', left(btrim(p_note), 1000)));
  return p_quantity;
end;
$$;

-- Excepción explícita: el cliente conserva el original (p. ej. política
-- comercial decidida por BEYONIX). Nunca automática; motivo obligatorio.
create or replace function public.waive_order_claim_original_return(
  p_claim_id bigint,
  p_actor_id uuid,
  p_order_item_id bigint,
  p_quantity integer,
  p_note text,
  p_idempotency_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[];
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_quantity is null or p_quantity <= 0 then raise exception 'CLAIM_LOGISTICS_INVALID'; end if;
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  perform 1 from public.order_claims where id = p_claim_id and status not in ('cerrado', 'rechazado') for update;
  if not found then raise exception 'CLAIM_TERMINAL'; end if;
  if not public.begin_order_claim_unit_event(p_claim_id, p_idempotency_key, 'waive:original', p_actor_id,
    jsonb_build_object('orderItemId', p_order_item_id, 'quantity', p_quantity, 'notes', left(btrim(p_note), 1000))) then
    return 0;
  end if;
  select array_agg(u.id order by u.id) into v_ids from (
    select u.id from public.order_claim_units u
    left join public.order_claim_shipments s on s.id = u.shipment_id
    where u.claim_id = p_claim_id and u.role = 'original' and u.order_item_id = p_order_item_id
      and u.location = 'con_cliente' and (u.shipment_id is null or s.closed_at is not null)
    order by u.id limit p_quantity for update of u
  ) u;
  if coalesce(array_length(v_ids, 1), 0) < p_quantity then raise exception 'CLAIM_UNITS_NOT_AVAILABLE'; end if;
  update public.order_claim_units set location = 'conservada_cliente', updated_at = clock_timestamp() where id = any (v_ids);
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_original_return_waived',
    jsonb_build_object('orderItemId', p_order_item_id, 'quantity', p_quantity, 'unitIds', to_jsonb(v_ids),
      'notes', left(btrim(p_note), 1000)));
  return p_quantity;
end;
$$;

-- Incidencias de inspección (producto distinto, cantidad incorrecta,
-- faltantes/accesorios, paquete vacío, daño/estado, otro): p_incident_type
-- NULL resuelve la incidencia. Mientras esté abierta frena el reenvío, la
-- NC/reintegro, cualquier operación Andreani y el cierre. Resolver exige un
-- motivo (mínimo 10 caracteres) y queda auditado.
create or replace function public.set_order_claim_units_incident(
  p_claim_id bigint,
  p_actor_id uuid,
  p_role text,
  p_order_item_id bigint,
  p_incident_type text,
  p_note text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_open boolean := p_incident_type is not null;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_role not in ('original', 'reemplazo') or (v_open and p_incident_type not in (
    'producto_distinto', 'cantidad_incorrecta', 'faltantes_accesorios', 'paquete_vacio', 'dano_estado', 'otro')) then
    raise exception 'CLAIM_LOGISTICS_INVALID';
  end if;
  if length(btrim(coalesce(p_note, ''))) < 5 or (not v_open and length(btrim(p_note)) < 10) then
    raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED';
  end if;
  perform 1 from public.order_claims where id = p_claim_id and status not in ('cerrado', 'rechazado') for update;
  if not found then raise exception 'CLAIM_TERMINAL'; end if;
  update public.order_claim_units
  set incident_open = v_open,
      incident_type = case when v_open then p_incident_type else incident_type end,
      incident_note = left(concat_ws(E'\n', incident_note,
        case when v_open then 'Incidencia: ' else 'Resuelta: ' end || btrim(p_note)), 2000),
      updated_at = clock_timestamp()
  where claim_id = p_claim_id and role = p_role and order_item_id = p_order_item_id
    and (incident_open is distinct from v_open or (v_open and incident_type is distinct from p_incident_type));
  get diagnostics v_count = row_count;
  if v_count > 0 then
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id,
      case when v_open then 'claim_units_incident_opened' else 'claim_units_incident_resolved' end,
      jsonb_build_object('role', p_role, 'orderItemId', p_order_item_id, 'units', v_count,
        'incidentType', p_incident_type, 'notes', left(btrim(p_note), 1000)));
  end if;
  return v_count;
end;
$$;

-- 14. Reemplazo: una reserva de stock única por unidad reclamada ----------

-- Igual a 20260920140000 salvo la exigencia de recepción previa, que pasa a
-- evaluarse en create_order_replacement con el plan logístico del reclamo.
create or replace function public.create_order_replacement_internal(
  p_original_order_id bigint,
  p_original_order_item_id bigint,
  p_replacement_variant_id bigint,
  p_quantity integer,
  p_reason text,
  p_actor_id uuid,
  p_idempotency_key text,
  p_condition_note text default null,
  p_notes text default null,
  p_claim_id bigint default null
)
returns public.order_replacements
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_original_item public.orden_items%rowtype;
  v_variant public.producto_variantes%rowtype;
  v_existing public.order_replacements%rowtype;
  v_unit_cost numeric;
  v_target_stock integer;
  v_result public.order_replacements%rowtype;
begin
  if auth.role() is distinct from 'service_role'
     or not exists (select 1 from public.profiles where id = p_actor_id and rol in ('admin', 'super_admin')) then
    raise exception 'REPLACEMENT_FORBIDDEN';
  end if;
  if p_reason not in ('mismo_producto', 'otra_variante', 'otro_producto', 'garantia') then
    raise exception 'REPLACEMENT_INVALID_REASON';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'REPLACEMENT_INVALID_QUANTITY';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'REPLACEMENT_IDEMPOTENCY_KEY_REQUIRED';
  end if;

  select * into v_existing from public.order_replacements where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  select * into v_original_item
  from public.orden_items
  where id = p_original_order_item_id and orden_id = p_original_order_id;
  if not found then
    raise exception 'No se encontró el producto dentro del pedido original.';
  end if;

  select * into v_variant
  from public.producto_variantes
  where id = p_replacement_variant_id;
  if not found then
    raise exception 'La variante de reemplazo no existe.';
  end if;

  perform pg_advisory_xact_lock(93000, v_variant.producto_id::integer);

  select stock into v_target_stock from public.producto_variantes where id = p_replacement_variant_id;
  v_target_stock := coalesce(v_target_stock, 0) - p_quantity;
  if v_target_stock < 0 then
    raise exception 'STOCK_INSUFICIENTE: no hay stock suficiente del producto/variante de reemplazo.';
  end if;

  v_unit_cost := public.compute_historical_unit_cost(v_variant.producto_id, p_replacement_variant_id, current_date);

  perform public.adjust_variant_stock_idempotent(
    p_replacement_variant_id,
    v_target_stock,
    'Salida por reemplazo del pedido #' || p_original_order_id,
    p_actor_id,
    'replacement:' || p_idempotency_key
  );

  insert into public.order_replacements (
    original_order_id, original_order_item_id, claim_id,
    replacement_product_id, replacement_variant_id, quantity, reason,
    condition_note, notes, unit_cost, idempotency_key, created_by
  ) values (
    p_original_order_id, p_original_order_item_id, p_claim_id,
    v_variant.producto_id, p_replacement_variant_id, p_quantity, p_reason,
    nullif(left(trim(coalesce(p_condition_note, '')), 500), ''),
    nullif(left(trim(coalesce(p_notes, '')), 1000), ''),
    v_unit_cost, p_idempotency_key, p_actor_id
  )
  returning * into v_result;

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, metadata)
  values (
    p_original_order_id, 'admin', p_actor_id, 'order_replacement_created',
    jsonb_build_object(
      'originalOrderItemId', p_original_order_item_id,
      'replacementProductId', v_variant.producto_id,
      'replacementVariantId', p_replacement_variant_id,
      'quantity', p_quantity,
      'reason', p_reason,
      'unitCost', v_unit_cost,
      'claimId', p_claim_id
    )
  );

  return v_result;
end;
$function$;

revoke all on function public.create_order_replacement_internal(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint)
  from public, anon, authenticated, service_role;

-- Igual a 20260922120000 más:
--   * con reclamo: reclamo aceptado de cambio/unidad faltante del mismo pedido
--     y tope por lo RECLAMADO de ese ítem (no por lo vendido), descontando
--     reemplazos devueltos;
--   * recepción previa del original salvo plan de intercambio simultáneo
--     (tramo "cambio" abierto y todavía no generado) o garantía explícita;
--   * nunca una reserva nueva con una operación Andreani ya en curso.
create or replace function public.create_order_replacement(
  p_original_order_id bigint, p_original_order_item_id bigint,
  p_replacement_variant_id bigint, p_quantity integer, p_reason text,
  p_actor_id uuid, p_idempotency_key text,
  p_condition_note text default null, p_notes text default null, p_claim_id bigint default null
) returns public.order_replacements language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare
  v_existing public.order_replacements;
  v_item public.orden_items;
  v_claim public.order_claims;
  v_used integer;
  v_claimed integer;
  v_claim_used integer;
  v_exchange boolean := false;
  v_result public.order_replacements;
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles where id = p_actor_id and rol in ('admin','super_admin')
  ) then raise exception 'REPLACEMENT_FORBIDDEN'; end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    raise exception 'REPLACEMENT_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('replacement:' || p_idempotency_key, 0));
  select * into v_existing from public.order_replacements where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.original_order_id <> p_original_order_id or v_existing.original_order_item_id <> p_original_order_item_id
      or v_existing.replacement_variant_id <> p_replacement_variant_id or v_existing.quantity <> p_quantity
      or v_existing.reason <> p_reason or v_existing.created_by <> p_actor_id
      or v_existing.claim_id is distinct from p_claim_id then raise exception 'REPLACEMENT_CONFLICT'; end if;
    return v_existing;
  end if;

  if p_claim_id is not null then
    -- Mismo orden de locks que la logística: reclamo -> ítem -> unidades.
    select * into v_claim from public.order_claims where id = p_claim_id and order_id = p_original_order_id for update;
    if not found or v_claim.status in ('recibido','en_revision','falta_informacion','cerrado','rechazado')
       or coalesce(v_claim.resolution, '') not in ('cambio_producto', 'envio_unidad_faltante') then
      raise exception 'REPLACEMENT_INVALID_CLAIM';
    end if;
    select sum((x->>'quantity')::integer) into v_claimed from jsonb_array_elements(v_claim.affected_items) x
    where (x->>'order_item_id')::bigint = p_original_order_item_id;
    if v_claimed is null then raise exception 'REPLACEMENT_INVALID_ITEM'; end if;
    if exists (select 1 from public.order_claim_shipments
               where claim_id = p_claim_id and closed_at is null and direction in ('cambio', 'reemplazo')
                 and creation_status in ('processing', 'created', 'manual_review')) then
      raise exception 'REPLACEMENT_LOGISTICS_LOCKED';
    end if;
    v_exchange := exists (select 1 from public.order_claim_shipments
                          where claim_id = p_claim_id and closed_at is null and direction = 'cambio' and status = 'pendiente');
    -- Un cambio nuevo (no legacy, con producto físico) siempre pasa por el
    -- método logístico elegido por el Admin: sin él, no hay reserva.
    if not v_claim.logistics_legacy and v_claim.resolution = 'cambio_producto'
       and coalesce(v_claim.failure_type, '') not in ('faltante', 'cantidad_menor')
       and not exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original') then
      raise exception 'REPLACEMENT_REQUIRES_PLAN';
    end if;
    -- Con logística de unidades, la reserva exige el método elegido por el
    -- Admin: cambio directo pendiente, o reenvío autorizado DESPUÉS de la
    -- inspección (Retiro + revisión). Nunca antes, nunca con incidencias.
    if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original') then
      if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open) then
        raise exception 'REPLACEMENT_REQUIRES_INSPECTION';
      end if;
      if not exists (select 1 from public.order_claim_shipments
                     where claim_id = p_claim_id and closed_at is null and status = 'pendiente'
                       and direction in ('cambio', 'reemplazo')) then
        raise exception 'REPLACEMENT_REQUIRES_PLAN';
      end if;
      if exists (select 1 from public.order_claim_shipments
                 where claim_id = p_claim_id and closed_at is null and direction = 'reemplazo')
         and not public.order_claim_originals_inspected(p_claim_id) then
        raise exception 'REPLACEMENT_REQUIRES_INSPECTION';
      end if;
    end if;
  end if;

  select * into v_item from public.orden_items where id = p_original_order_item_id and orden_id = p_original_order_id for update;
  if not found then raise exception 'REPLACEMENT_INVALID_ITEM'; end if;
  select coalesce(sum(quantity - reverted_quantity),0) into v_used
  from public.order_replacements where original_order_item_id = p_original_order_item_id;
  if p_quantity is null or p_quantity <= 0 or p_quantity + v_used > v_item.cantidad then
    raise exception 'REPLACEMENT_QUANTITY_EXCEEDED';
  end if;
  if p_claim_id is not null then
    select coalesce(sum(quantity - reverted_quantity),0) into v_claim_used
    from public.order_replacements where claim_id = p_claim_id and original_order_item_id = p_original_order_item_id;
    if p_quantity + v_claim_used > v_claimed then raise exception 'REPLACEMENT_QUANTITY_EXCEEDED'; end if;
  end if;
  if p_reason <> 'garantia' and not v_exchange
     and p_quantity + v_used > coalesce(v_item.return_restocked_quantity,0) + coalesce(v_item.return_written_off_quantity,0) then
    raise exception 'REPLACEMENT_REQUIRES_RECEIVED_ITEM';
  end if;
  if not exists (select 1 from public.producto_variantes v join public.productos p on p.id = v.producto_id
    where v.id = p_replacement_variant_id and v.activo and p.activo) then raise exception 'REPLACEMENT_UNAVAILABLE'; end if;
  v_result := public.create_order_replacement_internal(p_original_order_id,p_original_order_item_id,p_replacement_variant_id,
    p_quantity,p_reason,p_actor_id,p_idempotency_key,p_condition_note,p_notes,p_claim_id);
  return v_result;
end;
$$;
revoke all on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) to service_role;

-- Cada unidad reservada para un reclamo con logística queda registrada con
-- su ubicación: fuera del stock vendible desde el primer instante.
create or replace function public.order_replacement_claim_units()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.claim_id is null or not exists (
    select 1 from public.order_claim_units where claim_id = new.claim_id and role = 'original'
  ) then
    return new;
  end if;
  insert into public.order_claim_units (claim_id, order_id, order_item_id, role, replacement_id, location)
  select new.claim_id, new.original_order_id, new.original_order_item_id, 'reemplazo', new.id, 'reservada'
  from generate_series(1, new.quantity);
  return new;
end;
$$;

drop trigger if exists zz_order_replacement_claim_units on public.order_replacements;
create trigger zz_order_replacement_claim_units
  after insert on public.order_replacements
  for each row execute function public.order_replacement_claim_units();

-- 15. Cierre y resolución: nunca con logística abierta -------------------

create or replace function public.guard_order_claim_logistics()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.order_claim_shipments where claim_id = new.id)
     and not exists (select 1 from public.order_claim_units where claim_id = new.id) then
    return new;
  end if;

  -- La resolución no se cambia en silencio con una operación física iniciada.
  if new.resolution is distinct from old.resolution and old.resolution is not null
     and not (new.status = 'rechazado' and new.resolution = 'rechazado') then
    if exists (select 1 from public.order_claim_shipments
               where claim_id = new.id and status <> 'cancelada'
                 and creation_status in ('processing', 'created', 'manual_review'))
       or exists (select 1 from public.order_claim_units where claim_id = new.id and role = 'reemplazo')
       or exists (select 1 from public.order_claim_units where claim_id = new.id and role = 'original' and location <> 'con_cliente') then
      raise exception 'CLAIM_LOGISTICS_LOCKED';
    end if;
  end if;

  if new.status in ('cerrado', 'rechazado') and old.status is distinct from new.status then
    if exists (select 1 from public.order_claim_shipments
               where claim_id = new.id and (creation_status in ('processing', 'manual_review')
                 or (closed_at is null and creation_status = 'created'))) then
      raise exception 'CLAIM_LOGISTICS_OPEN';
    end if;
    if exists (select 1 from public.order_claim_units where claim_id = new.id and incident_open)
       or exists (select 1 from public.order_claim_shipments where claim_id = new.id and review_required) then
      raise exception 'CLAIM_LOGISTICS_INCIDENT';
    end if;
    if exists (select 1 from public.order_claim_units where claim_id = new.id
               and ((role = 'reemplazo' and location in ('reservada', 'en_andreani', 'recibida_beyonix'))
                 or (role = 'original' and location in ('en_andreani', 'recibida_beyonix')))) then
      raise exception 'CLAIM_LOGISTICS_OPEN';
    end if;
    -- Nunca: producto original en poder del cliente + reemplazo entregado.
    if exists (
      select 1 from (
        select order_item_id,
          count(*) filter (where role = 'reemplazo' and location = 'entregada_cliente') delivered,
          count(*) filter (where role = 'original' and location in ('reincorporada_stock', 'baja', 'conservada_cliente')) settled
        from public.order_claim_units where claim_id = new.id group by order_item_id
      ) x where x.delivered > x.settled
    ) then
      raise exception 'CLAIM_ORIGINAL_NOT_RETURNED';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists order_claim_logistics_guard on public.order_claims;
create trigger order_claim_logistics_guard
  before update of status, resolution on public.order_claims
  for each row execute function public.guard_order_claim_logistics();

-- Al cerrar/rechazar, lo que nunca salió del cliente queda con el cliente.
-- Un tramo que nunca llegó a Andreani se cancela si ya no corresponde.
create or replace function public.settle_order_claim_units_on_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('cerrado', 'rechazado') and old.status is distinct from new.status then
    update public.order_claim_units set location = 'conservada_cliente', updated_at = clock_timestamp()
    where claim_id = new.id and role = 'original' and location = 'con_cliente';
    update public.order_claim_shipments set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
    where claim_id = new.id and closed_at is null and creation_status in ('not_started', 'failed');
  elsif new.resolution is distinct from old.resolution and old.resolution = 'cambio_producto' then
    update public.order_claim_shipments set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
    where claim_id = new.id and closed_at is null and direction in ('cambio', 'reemplazo')
      and creation_status in ('not_started', 'failed');
  end if;
  return new;
end;
$$;

drop trigger if exists zz_order_claim_settle_units_on_close on public.order_claims;
create trigger zz_order_claim_settle_units_on_close
  after update of status, resolution on public.order_claims
  for each row execute function public.settle_order_claim_units_on_close();

-- 16. Permisos ------------------------------------------------------------

revoke all on function public.order_claim_leg_rank(text) from public, anon, authenticated;
revoke all on function public.post_order_claim_system_message(bigint, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.log_order_claim_logistics(bigint, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.assert_order_claim_logistics_admin(uuid) from public, anon, authenticated, service_role;
revoke all on function public.begin_order_claim_unit_event(bigint, text, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ensure_order_claim_original_units(public.order_claims) from public, anon, authenticated, service_role;
revoke all on function public.order_claim_is_accepted(public.order_claims) from public, anon, authenticated;
revoke all on function public.order_claim_logistics_plan(bigint) from public, anon, authenticated;
revoke all on function public.order_claim_originals_inspected(bigint) from public, anon, authenticated;
revoke all on function public.open_order_claim_leg(public.order_claims, text, uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.order_claim_leg_readiness(public.order_claim_shipments) from public, anon, authenticated, service_role;
revoke all on function public.assign_order_claim_leg_units(public.order_claim_shipments) from public, anon, authenticated, service_role;
revoke all on function public.release_order_claim_leg_units(bigint) from public, anon, authenticated, service_role;
revoke all on function public.refresh_order_claim_leg_closure(bigint) from public, anon, authenticated, service_role;
revoke all on function public.order_claim_change_accepted() from public, anon, authenticated;
revoke all on function public.order_claim_shipment_created_effects(public.order_claim_shipments) from public, anon, authenticated, service_role;
revoke all on function public.order_claim_leg_progress_effects(public.order_claim_shipments, text) from public, anon, authenticated, service_role;
revoke all on function public.apply_return_movement_to_claim_units() from public, anon, authenticated;
revoke all on function public.settle_order_claim_replacement_units(bigint, uuid, bigint[], integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.order_replacement_claim_units() from public, anon, authenticated;
revoke all on function public.guard_order_claim_logistics() from public, anon, authenticated;
revoke all on function public.settle_order_claim_units_on_close() from public, anon, authenticated;

revoke all on function public.request_order_claim_logistics(bigint, uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_order_claim_leg(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_order_claim_shipment_creation(bigint, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.complete_order_claim_shipment_creation(bigint, uuid, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.fail_order_claim_shipment_creation(bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.resolve_order_claim_shipment_reconciliation(bigint, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.apply_order_claim_shipment_tracking(bigint, text, boolean, text, text, text, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.mark_order_claim_exchange_not_completed(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.register_order_claim_units_arrival(bigint, uuid, text, bigint, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.inspect_order_claim_replacement_units(bigint, uuid, bigint, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.release_order_claim_replacement_reservation(bigint, uuid, bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.confirm_order_claim_replacement_delivered_manually(bigint, uuid, bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.waive_order_claim_original_return(bigint, uuid, bigint, integer, text, text) from public, anon, authenticated;
revoke all on function public.set_order_claim_units_incident(bigint, uuid, text, bigint, text, text) from public, anon, authenticated;

grant execute on function public.request_order_claim_logistics(bigint, uuid, text, text, text, text, text) to service_role;
grant execute on function public.cancel_order_claim_leg(bigint, uuid, text) to service_role;
grant execute on function public.claim_order_claim_shipment_creation(bigint, uuid, text, text, text) to service_role;
grant execute on function public.complete_order_claim_shipment_creation(bigint, uuid, text, text, text, numeric) to service_role;
grant execute on function public.fail_order_claim_shipment_creation(bigint, uuid, text, text) to service_role;
grant execute on function public.resolve_order_claim_shipment_reconciliation(bigint, uuid, text, text, text, text) to service_role;
grant execute on function public.apply_order_claim_shipment_tracking(bigint, text, boolean, text, text, text, timestamptz, timestamptz, text) to service_role;
revoke all on function public.flag_order_claim_shipment_review(bigint, text) from public, anon, authenticated;
revoke all on function public.resolve_order_claim_shipment_review(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.flag_order_claim_shipment_review(bigint, text) to service_role;
grant execute on function public.resolve_order_claim_shipment_review(bigint, uuid, text) to service_role;
grant execute on function public.mark_order_claim_exchange_not_completed(bigint, uuid, text) to service_role;
grant execute on function public.register_order_claim_units_arrival(bigint, uuid, text, bigint, integer, text, text, text) to service_role;
grant execute on function public.inspect_order_claim_replacement_units(bigint, uuid, bigint, integer, integer, text, text) to service_role;
grant execute on function public.release_order_claim_replacement_reservation(bigint, uuid, bigint, integer, text, text) to service_role;
grant execute on function public.confirm_order_claim_replacement_delivered_manually(bigint, uuid, bigint, integer, text, text) to service_role;
grant execute on function public.waive_order_claim_original_return(bigint, uuid, bigint, integer, text, text) to service_role;
grant execute on function public.set_order_claim_units_incident(bigint, uuid, text, bigint, text, text) to service_role;


-- 17. NC y reintegro: nunca con el producto sin volver/inspeccionar ---------
-- Se agrega a la maquinaria existente (begin_partial_credit_note y
-- commit_order_refund_proof no se tocan; ya impiden doble NC por ítem, doble
-- NC en proceso, exceso sobre lo facturado/reintegrable y doble reintegro):
--   * una incidencia de inspección o una revisión Andreani abierta bloquea
--     SIEMPRE la NC y el reintegro;
--   * con unidades originales del reclamo todavía con el cliente, en Andreani
--     o sin inspeccionar, sólo pasa con una excepción administrativa
--     registrada ANTES (Admin, motivo >= 10 caracteres, auditada), que la NC
--     consume una única vez.

create table if not exists public.order_claim_financial_exceptions (
  id bigint generated by default as identity primary key,
  claim_id bigint not null references public.order_claims(id) on delete restrict,
  actor_id uuid not null,
  reason text not null check (length(btrim(reason)) >= 10),
  credit_note_id uuid,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.order_claim_financial_exceptions enable row level security;
revoke all on table public.order_claim_financial_exceptions from public, anon, authenticated;
grant select on table public.order_claim_financial_exceptions to service_role;

create or replace function public.order_claim_money_block(p_claim_id bigint)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
      or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and review_required)
      then 'CLAIM_MONEY_INCIDENT_OPEN'
    when exists (select 1 from public.order_claim_units
                 where claim_id = p_claim_id and role = 'original'
                   and location in ('con_cliente', 'en_andreani', 'recibida_beyonix'))
      then 'CLAIM_MONEY_RETURN_PENDING'
  end
$$;

create or replace function public.register_claim_financial_exception(
  p_claim_id bigint,
  p_actor_id uuid,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
  v_block text;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  perform 1 from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  v_block := public.order_claim_money_block(p_claim_id);
  if v_block = 'CLAIM_MONEY_INCIDENT_OPEN' then raise exception 'CLAIM_MONEY_INCIDENT_OPEN'; end if;
  if v_block is null then return null; end if;
  select id into v_id from public.order_claim_financial_exceptions
  where claim_id = p_claim_id and consumed_at is null order by id limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.order_claim_financial_exceptions (claim_id, actor_id, reason)
  values (p_claim_id, p_actor_id, left(btrim(p_reason), 1000))
  returning id into v_id;
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_financial_exception_registered',
    jsonb_build_object('exceptionId', v_id, 'block', v_block, 'reason', left(btrim(p_reason), 1000)));
  return v_id;
end;
$$;

create or replace function public.guard_claim_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_block text;
  v_exception bigint;
begin
  if new.claim_id is null then return new; end if;
  v_block := public.order_claim_money_block(new.claim_id);
  if v_block is null then return new; end if;
  if v_block = 'CLAIM_MONEY_INCIDENT_OPEN' then raise exception 'CLAIM_MONEY_INCIDENT_OPEN'; end if;
  update public.order_claim_financial_exceptions
  set consumed_at = clock_timestamp(), credit_note_id = new.id
  where id = (select id from public.order_claim_financial_exceptions
              where claim_id = new.claim_id and consumed_at is null order by id limit 1 for update)
  returning id into v_exception;
  if v_exception is null then raise exception 'CLAIM_MONEY_RETURN_PENDING'; end if;
  perform public.log_order_claim_logistics(new.claim_id, new.created_by, 'claim_financial_exception_used',
    jsonb_build_object('exceptionId', v_exception, 'creditNoteId', new.id));
  return new;
end;
$$;

drop trigger if exists aa_guard_claim_credit_note on public.order_credit_notes;
create trigger aa_guard_claim_credit_note
  before insert on public.order_credit_notes
  for each row execute function public.guard_claim_credit_note();

-- Dinero que vuelve al cliente fuera de una NC (comprobante de transferencia o
-- refund real de Mercado Pago): mismo criterio para todos los canales.
create or replace function public.assert_order_claim_money_released(p_order_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim_id bigint;
  v_block text;
begin
  select c.id into v_claim_id from public.order_claims c
  where c.order_id = p_order_id and c.status not in ('cerrado', 'rechazado')
    and exists (select 1 from public.order_claim_units u where u.claim_id = c.id)
  order by c.id desc limit 1;
  if v_claim_id is null then return; end if;
  v_block := public.order_claim_money_block(v_claim_id);
  if v_block is null then return; end if;
  if v_block = 'CLAIM_MONEY_INCIDENT_OPEN' then raise exception 'CLAIM_MONEY_INCIDENT_OPEN'; end if;
  -- Sólo el dinero ya autorizado por una excepción explícita de este reclamo.
  if not exists (select 1 from public.order_claim_financial_exceptions where claim_id = v_claim_id) then
    raise exception 'CLAIM_MONEY_RETURN_PENDING';
  end if;
end;
$$;

create or replace function public.guard_claim_refund_proof()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_order_claim_money_released(new.order_id);
  return new;
end;
$$;

drop trigger if exists aa_guard_claim_refund_proof on public.order_refund_proofs;
create trigger aa_guard_claim_refund_proof
  before insert on public.order_refund_proofs
  for each row execute function public.guard_claim_refund_proof();

-- Refund real de Mercado Pago: se valida cada vez que un intento pasa a
-- 'processing' (intento nuevo o reintento de uno 'requested'), justo antes
-- de que la aplicación llame a Mercado Pago. begin_mercadopago_order_refund
-- no se toca (ya serializa por pedido y evita dos POST).
create or replace function public.guard_claim_mercadopago_refund()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'processing' and (tg_op = 'INSERT' or old.status is distinct from 'processing') then
    perform public.assert_order_claim_money_released(new.order_id);
  end if;
  return new;
end;
$$;

do $$
begin
  if to_regclass('public.mercadopago_order_refunds') is not null then
    drop trigger if exists aa_guard_claim_mercadopago_refund on public.mercadopago_order_refunds;
    create trigger aa_guard_claim_mercadopago_refund
      before insert or update of status on public.mercadopago_order_refunds
      for each row execute function public.guard_claim_mercadopago_refund();
  end if;
end;
$$;

revoke all on function public.order_claim_money_block(bigint) from public, anon, authenticated;
revoke all on function public.register_claim_financial_exception(bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.guard_claim_credit_note() from public, anon, authenticated;
revoke all on function public.guard_claim_refund_proof() from public, anon, authenticated;
revoke all on function public.guard_claim_mercadopago_refund() from public, anon, authenticated;
revoke all on function public.assert_order_claim_money_released(bigint) from public, anon, authenticated, service_role;
revoke all on function public.guard_return_movement_claim_units() from public, anon, authenticated;
grant execute on function public.register_claim_financial_exception(bigint, uuid, text) to service_role;

-- 18. Funciones del modelo inicial que ya no corresponden ---------------------
-- Creaban/operaban tramos por (reclamo, dirección) con modalidades de
-- domicilio y un "listo" sin sucursal ni unidades. Se eliminan para que no
-- quede ningún camino paralelo.

drop function if exists public.order_claim_shipment_ready(bigint, text);
drop function if exists public.claim_order_claim_shipment_creation(bigint, text, uuid, text, text, text);
drop function if exists public.complete_order_claim_shipment_creation(bigint, text, uuid, text, text, text, numeric);
drop function if exists public.fail_order_claim_shipment_creation(bigint, text, uuid, text, text);
drop function if exists public.resolve_order_claim_shipment_reconciliation(bigint, text, uuid, text, text, text, text);
drop function if exists public.apply_order_claim_shipment_tracking(bigint, text, text, text, text, text, timestamptz);

notify pgrst, 'reload schema';

commit;
