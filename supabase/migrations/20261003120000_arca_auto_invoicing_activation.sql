-- Activación persistente y auditable de Factura C automática PROD.
-- La cola histórica no se modifica: el cutoff se aplica sólo al claim automático.
begin;

create table public.arca_auto_invoicing_control (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  cutoff_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint arca_auto_cutoff_required check (not enabled or cutoff_at is not null)
);

insert into public.arca_auto_invoicing_control (id, enabled) values (true, false);

create table public.arca_auto_invoicing_events (
  id bigint generated always as identity primary key,
  enabled boolean not null,
  cutoff_at timestamptz,
  actor_id uuid not null,
  created_at timestamptz not null default now()
);

alter table public.arca_auto_invoicing_control enable row level security;
alter table public.arca_auto_invoicing_events enable row level security;
revoke all on public.arca_auto_invoicing_control, public.arca_auto_invoicing_events from public, anon, authenticated;
-- Las escrituras pasan por set_arca_auto_invoicing para conservar cutoff y auditoría.
grant select on public.arca_auto_invoicing_control to service_role;
grant select on public.arca_auto_invoicing_events to service_role;

create function public.set_arca_auto_invoicing(p_enabled boolean, p_actor uuid)
returns public.arca_auto_invoicing_control
language plpgsql
security definer
set search_path = public
as $$
declare
  v_control public.arca_auto_invoicing_control%rowtype;
  v_cutoff timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_enabled is null or p_actor is null then
    raise exception 'INVALID_ARCA_AUTO_CONTROL';
  end if;

  select * into strict v_control from public.arca_auto_invoicing_control where id = true for update;
  if v_control.enabled = p_enabled then return v_control; end if;

  if p_enabled then
    -- Primera Factura C fiscal emitida manualmente y persistida antes de habilitar.
    if not exists (
      select 1 from public.ordenes o
      where o.invoice_status = 'authorized'
        and o.invoice_arca_environment = 'production'
        and nullif(o.invoice_cae, '') is not null
        and exists (
          select 1 from public.order_audit_events e
          where e.order_id = o.id
            and e.action = 'arca_invoice_attempt_started'
            and e.metadata->>'manual' = 'true'
        )
    ) then
      raise exception 'ARCA_FIRST_MANUAL_INVOICE_REQUIRED';
    end if;
    v_cutoff := clock_timestamp();
  else
    v_cutoff := v_control.cutoff_at;
  end if;

  update public.arca_auto_invoicing_control
  set enabled = p_enabled, cutoff_at = v_cutoff, updated_at = clock_timestamp(), updated_by = p_actor
  where id = true returning * into v_control;

  insert into public.arca_auto_invoicing_events (enabled, cutoff_at, actor_id)
  values (v_control.enabled, v_control.cutoff_at, p_actor);
  return v_control;
end;
$$;

revoke all on function public.set_arca_auto_invoicing(boolean, uuid) from public, anon, authenticated;
grant execute on function public.set_arca_auto_invoicing(boolean, uuid) to service_role;

-- Conserva la firma y toda la máquina fiscal existente; añade el filtro antes
-- de tomar un pedido. El camino manual no consulta el control ni el cutoff.
create or replace function public.claim_arca_invoice(
  p_order_id bigint default null,
  p_lease interval default interval '10 minutes',
  p_manual boolean default false
)
returns setof public.ordenes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_now timestamptz := clock_timestamp();
  v_cutoff timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_manual is not true then
    select cutoff_at into v_cutoff
    from public.arca_auto_invoicing_control
    where id = true and enabled = true
    for share;
    if v_cutoff is null then return; end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('beyonix-arca-invoice-processing'));

  if exists (
    select 1 from public.ordenes
    where invoice_status = 'processing'
      and invoice_processing_started_at > v_now - p_lease
      and (p_order_id is null or id <> p_order_id)
  ) then
    if p_manual then raise exception 'INVOICE_PROCESSING_IN_PROGRESS'; end if;
    return;
  end if;

  if p_order_id is not null then
    select * into v_order from public.ordenes where id = p_order_id for update;
    if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  else
    select * into v_order from public.ordenes o
    where ((o.invoice_status in ('pending', 'error') and o.invoice_next_attempt_at <= v_now)
       or (o.invoice_status = 'processing' and o.invoice_processing_started_at <= v_now - p_lease))
      and o.invoice_queued_at > v_cutoff
      and o.invoice_cae is null
      and o.invoice_number is null
      and (o.invoice_arca_environment is null or o.invoice_arca_environment = 'production')
    order by o.invoice_next_attempt_at nulls first, o.id
    limit 1
    for update of o skip locked;
    if not found then return; end if;
  end if;

  if p_manual is not true and (
    v_order.invoice_queued_at is null or v_order.invoice_queued_at <= v_cutoff
    or v_order.invoice_cae is not null or v_order.invoice_number is not null
    or v_order.invoice_arca_environment = 'homologation'
    or v_order.invoice_status not in ('pending', 'error', 'processing')
  ) then return; end if;

  if v_order.invoice_status = 'authorized' and v_order.invoice_cae is not null then
    if p_manual then raise exception 'INVOICE_ALREADY_AUTHORIZED'; end if;
    return;
  end if;
  if v_order.invoice_status = 'processing'
     and v_order.invoice_processing_started_at > v_now - p_lease then
    if p_manual then raise exception 'INVOICE_ALREADY_PROCESSING'; end if;
    return;
  end if;

  -- Un número ya solicitado exige conciliación aun si la venta se canceló.
  if v_order.invoice_requested_number is null and not public.order_is_invoiceable(v_order) then
    if p_manual then raise exception 'ORDER_NOT_INVOICEABLE'; end if;
    update public.ordenes
    set invoice_status = null, invoice_next_attempt_at = null
    where id = v_order.id and invoice_status in ('pending', 'error');
    return;
  end if;

  update public.ordenes
  set invoice_status = 'processing',
      invoice_processing_started_at = v_now,
      invoice_last_attempt_at = v_now,
      invoice_attempts = coalesce(invoice_attempts, 0) + 1,
      invoice_queued_at = coalesce(invoice_queued_at, v_now)
  where id = v_order.id
  returning * into v_order;

  insert into public.order_audit_events (order_id, actor_type, action, previous_status, new_status, metadata)
  values (v_order.id, 'system', 'arca_invoice_attempt_started', null, 'processing',
    jsonb_build_object('attempt', v_order.invoice_attempts, 'manual', p_manual,
      'reconciling', v_order.invoice_requested_number is not null,
      'requestedNumber', v_order.invoice_requested_number));

  return next v_order;
end;
$$;

revoke all on function public.claim_arca_invoice(bigint, interval, boolean) from public, anon, authenticated;
grant execute on function public.claim_arca_invoice(bigint, interval, boolean) to service_role;

create index ordenes_arca_auto_cutoff_idx
  on public.ordenes (invoice_queued_at, invoice_next_attempt_at, id)
  where invoice_status in ('pending', 'error', 'processing') and invoice_cae is null;

commit;
