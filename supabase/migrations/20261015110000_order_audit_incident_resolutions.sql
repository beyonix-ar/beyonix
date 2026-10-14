-- Resolución de incidentes de pago auditados (reintegro externo o
-- contracargo detectado en Mercado Pago). El evento original de
-- order_audit_events NUNCA se modifica ni se borra: la resolución vive en esta
-- tabla y el incidente deja de ser una alerta activa, pero sigue en el
-- historial. Sólo aplica a las acciones de incidente: ningún otro evento puede
-- marcarse como resuelto.

create table if not exists public.order_audit_incident_resolutions (
  audit_event_id bigint primary key
    references public.order_audit_events(id) on delete cascade,
  resolution text not null,
  note text not null,
  resolved_by uuid not null,
  resolved_at timestamptz not null default now(),
  constraint order_audit_incident_resolutions_resolution_check
    check (resolution in ('false_positive', 'resolved')),
  constraint order_audit_incident_resolutions_note_check
    check (length(btrim(note)) between 3 and 500)
);

alter table public.order_audit_incident_resolutions enable row level security;
revoke all on public.order_audit_incident_resolutions from public, anon, authenticated;
grant all on public.order_audit_incident_resolutions to service_role;

comment on table public.order_audit_incident_resolutions is
  'Resolución (falso positivo / resuelto) de un incidente de pago auditado. El evento original queda intacto en order_audit_events.';

create or replace function public.resolve_order_audit_incident(
  p_audit_event_id bigint,
  p_resolution text,
  p_note text,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.order_audit_events%rowtype;
  v_existing public.order_audit_incident_resolutions%rowtype;
  v_role text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN';
  end if;

  select rol into v_role from public.profiles where id = p_actor;
  if coalesce(v_role, '') not in ('admin', 'super_admin') then
    raise exception 'INCIDENT_RESOLUTION_FORBIDDEN';
  end if;

  if p_resolution not in ('false_positive', 'resolved') then
    raise exception 'INVALID_INCIDENT_RESOLUTION';
  end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'INCIDENT_RESOLUTION_NOTE_REQUIRED';
  end if;

  select * into v_event
  from public.order_audit_events
  where id = p_audit_event_id
  for update;

  if not found then
    raise exception 'INCIDENT_NOT_FOUND';
  end if;
  if v_event.action not in ('mp_external_refund_detected', 'mp_chargeback_detected') then
    raise exception 'NOT_A_PAYMENT_INCIDENT';
  end if;

  -- Idempotente: un segundo click (o dos pestañas) devuelve la resolución
  -- ya registrada y nunca la pisa.
  select * into v_existing
  from public.order_audit_incident_resolutions
  where audit_event_id = p_audit_event_id;
  if found then
    return jsonb_build_object(
      'audit_event_id', v_existing.audit_event_id,
      'resolution', v_existing.resolution,
      'note', v_existing.note,
      'resolved_at', v_existing.resolved_at,
      'already_resolved', true
    );
  end if;

  insert into public.order_audit_incident_resolutions (audit_event_id, resolution, note, resolved_by)
  values (p_audit_event_id, p_resolution, btrim(p_note), p_actor)
  returning * into v_existing;

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (
    v_event.order_id,
    'admin',
    p_actor,
    'audit_incident_resolved',
    v_event.new_status,
    v_event.new_status,
    jsonb_build_object(
      'auditEventId', p_audit_event_id,
      'incidentAction', v_event.action,
      'resolution', p_resolution,
      'note', btrim(p_note)
    )
  );

  return jsonb_build_object(
    'audit_event_id', v_existing.audit_event_id,
    'resolution', v_existing.resolution,
    'note', v_existing.note,
    'resolved_at', v_existing.resolved_at,
    'already_resolved', false
  );
end;
$$;

revoke all on function public.resolve_order_audit_incident(bigint, text, text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_order_audit_incident(bigint, text, text, uuid) to service_role;

comment on function public.resolve_order_audit_incident(bigint, text, text, uuid) is
  'Marca un incidente de pago (reintegro externo / contracargo) como falso positivo o resuelto, sin tocar el evento original. Idempotente.';
