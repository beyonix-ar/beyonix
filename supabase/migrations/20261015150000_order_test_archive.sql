-- Archivo de pedidos de prueba y protección de pedidos con rastro fiscal.
--
-- Archivar NO borra: el pedido sale de las vistas operativas del Admin (y,
-- opcionalmente, de la cuenta del cliente) pero conserva pago, factura, NC,
-- reintegros y auditoría. Sólo un super_admin, con motivo, y únicamente si el
-- pedido no tiene nada pendiente (order_archive_blockers). Las columnas sólo
-- se modifican desde las RPC: un UPDATE directo (incluido el de un admin desde
-- el navegador) se rechaza.
--
-- Además, un pedido con rastro de dinero o fiscal (pago, factura, NC,
-- reintegro, saldo, envío, reclamo) ya no puede eliminarse por ningún camino.

alter table public.ordenes
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid,
  add column if not exists archive_reason text,
  add column if not exists customer_hidden_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ordenes_archive_consistency_check') then
    alter table public.ordenes add constraint ordenes_archive_consistency_check check (
      (archived_at is null and archived_by is null and archive_reason is null and customer_hidden_at is null)
      or (archived_at is not null and archived_by is not null and length(btrim(coalesce(archive_reason, ''))) between 5 and 500)
    );
  end if;
end $$;

create index if not exists ordenes_archived_at_idx on public.ordenes (archived_at) where archived_at is not null;

comment on column public.ordenes.archived_at is 'Pedido archivado (fuera de las vistas operativas del Admin). Nunca implica borrado.';
comment on column public.ordenes.customer_hidden_at is 'Pedido de prueba oculto también en la cuenta del cliente. Sólo con archived_at.';

-- Rastro que impide ELIMINAR un pedido (nunca se borra dinero ni fiscalidad).
create or replace function public.order_delete_blockers_for_row(p_order jsonb)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id bigint := (p_order->>'id')::bigint;
  v_blockers text[] := array[]::text[];
begin
  if p_order->>'paid_at' is not null
     or p_order->>'payment_confirmed_at' is not null
     or coalesce((p_order->>'payment_confirmed_amount')::numeric, 0) > 0
     or coalesce(p_order->>'payment_status', '') in (
       'approved', 'confirmado', 'confirmed', 'refunded', 'charged_back', 'in_mediation',
       'approved_amount_mismatch', 'approved_currency_mismatch', 'approved_stock_conflict',
       'approved_after_cancellation', 'auto_verified_stock_conflict')
     or p_order->>'payment_proof_uploaded_at' is not null then
    v_blockers := array_append(v_blockers, 'payment');
  end if;
  if p_order->>'invoice_cae' is not null
     or coalesce(p_order->>'invoice_status', '') in ('authorized', 'processing') then
    v_blockers := array_append(v_blockers, 'invoice');
  end if;
  if exists (select 1 from public.order_credit_notes where order_id = v_id) then
    v_blockers := array_append(v_blockers, 'credit_note');
  end if;
  if p_order->>'refund_pending_at' is not null
     or p_order->>'refunded_at' is not null
     or exists (select 1 from public.mercadopago_order_refunds where order_id = v_id) then
    v_blockers := array_append(v_blockers, 'refund');
  end if;
  if coalesce((p_order->>'credit_balance_used')::numeric, 0) > 0
     or exists (select 1 from public.customer_credit_movements where order_id = v_id) then
    v_blockers := array_append(v_blockers, 'customer_credit');
  end if;
  if p_order->>'andreani_envio_id' is not null or p_order->>'tracking_number' is not null then
    v_blockers := array_append(v_blockers, 'shipment');
  end if;
  if exists (select 1 from public.order_claims where order_id = v_id) then
    v_blockers := array_append(v_blockers, 'claim');
  end if;
  return v_blockers;
end;
$$;

create or replace function public.order_delete_blockers(p_order_id bigint)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_order jsonb;
begin
  select to_jsonb(o) into v_order from public.ordenes o where o.id = p_order_id;
  if v_order is null then
    return array['not_found'];
  end if;
  return public.order_delete_blockers_for_row(v_order);
end;
$$;

create or replace function public.guard_order_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_blockers text[] := public.order_delete_blockers_for_row(to_jsonb(old));
begin
  if cardinality(v_blockers) > 0 then
    raise exception 'ORDER_DELETE_BLOCKED:%', array_to_string(v_blockers, ',');
  end if;
  return old;
end;
$$;

drop trigger if exists guard_order_delete on public.ordenes;
create trigger guard_order_delete
  before delete on public.ordenes
  for each row execute function public.guard_order_delete();

-- Lo que impide ARCHIVAR: cualquier acción operativa, fiscal o de dinero abierta.
create or replace function public.order_archive_blockers(p_order_id bigint)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_order public.ordenes%rowtype;
  v_blockers text[] := array[]::text[];
  v_authorized_nc numeric;
begin
  select * into v_order from public.ordenes where id = p_order_id;
  if not found then
    return array['not_found'];
  end if;

  if v_order.archived_at is not null then
    v_blockers := array_append(v_blockers, 'already_archived');
  end if;
  -- Pagado sin entregar, pendiente de pago, preparando, en camino, etc.
  if coalesce(v_order.estado, '') not in ('cancelado', 'entregado') then
    v_blockers := array_append(v_blockers, 'active_order');
  end if;
  if coalesce(v_order.financial_status, '') in ('cancellation_requested', 'refund_pending') then
    v_blockers := array_append(v_blockers, 'financial_in_progress');
  end if;
  if coalesce(v_order.invoice_status, '') in ('pending', 'processing', 'error') then
    v_blockers := array_append(v_blockers, 'invoice_in_progress');
  end if;
  if exists (select 1 from public.order_credit_notes where order_id = p_order_id and status = 'processing') then
    v_blockers := array_append(v_blockers, 'credit_note_processing');
  end if;
  select coalesce(sum(total_amount), 0) into v_authorized_nc
  from public.order_credit_notes where order_id = p_order_id and status = 'authorized';
  if v_order.credit_note_required is true
     and v_order.invoice_status = 'authorized'
     and v_authorized_nc + 0.01 < coalesce(v_order.total, 0) then
    v_blockers := array_append(v_blockers, 'credit_note_pending');
  end if;
  if exists (
    select 1 from public.mercadopago_order_refunds
    where order_id = p_order_id and status in ('requested', 'processing', 'needs_reconciliation')
  ) then
    v_blockers := array_append(v_blockers, 'refund_in_progress');
  end if;
  if exists (
    select 1 from public.order_audit_events e
    where e.order_id = p_order_id
      and e.action in ('mp_external_refund_detected', 'mp_chargeback_detected')
      and not exists (select 1 from public.order_audit_incident_resolutions r where r.audit_event_id = e.id)
  ) then
    v_blockers := array_append(v_blockers, 'open_payment_incident');
  end if;
  if exists (
    select 1 from public.order_claims
    where order_id = p_order_id and coalesce(status, '') not in ('cerrado', 'rechazado')
  ) then
    v_blockers := array_append(v_blockers, 'open_claim');
  end if;
  if v_order.andreani_envio_id is not null and coalesce(v_order.estado, '') <> 'entregado' then
    v_blockers := array_append(v_blockers, 'shipment_in_progress');
  end if;
  return v_blockers;
end;
$$;

-- Las columnas de archivo sólo cambian desde las RPC (que fijan este flag local).
create or replace function public.guard_order_archive_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (new.archived_at, new.archived_by, new.archive_reason, new.customer_hidden_at)
       is distinct from (old.archived_at, old.archived_by, old.archive_reason, old.customer_hidden_at)
     and coalesce(current_setting('beyonix.order_archive', true), '') <> 'on' then
    raise exception 'ORDER_ARCHIVE_COLUMNS_PROTECTED';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_order_archive_columns on public.ordenes;
create trigger guard_order_archive_columns
  before update on public.ordenes
  for each row execute function public.guard_order_archive_columns();

create or replace function public.archive_order_admin(
  p_order_id bigint,
  p_actor uuid,
  p_reason text,
  p_hide_from_customer boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_order public.ordenes%rowtype;
  v_blockers text[];
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  select rol into v_role from public.profiles where id = p_actor;
  if coalesce(v_role, '') <> 'super_admin' then
    raise exception 'ORDER_ARCHIVE_FORBIDDEN';
  end if;
  if length(v_reason) not between 5 and 500 then
    raise exception 'ORDER_ARCHIVE_REASON_REQUIRED';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  v_blockers := public.order_archive_blockers(p_order_id);
  if cardinality(v_blockers) > 0 then
    raise exception 'ORDER_ARCHIVE_BLOCKED:%', array_to_string(v_blockers, ',');
  end if;

  perform set_config('beyonix.order_archive', 'on', true);
  update public.ordenes
  set archived_at = now(),
      archived_by = p_actor,
      archive_reason = v_reason,
      customer_hidden_at = case when p_hide_from_customer then now() else null end
  where id = p_order_id
  returning * into v_order;
  perform set_config('beyonix.order_archive', '', true);

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (p_order_id, 'admin', p_actor, 'order_archived', v_order.estado, v_order.estado,
    jsonb_build_object('reason', v_reason, 'hideFromCustomer', coalesce(p_hide_from_customer, false)));

  return jsonb_build_object(
    'id', v_order.id,
    'archived_at', v_order.archived_at,
    'archived_by', v_order.archived_by,
    'archive_reason', v_order.archive_reason,
    'customer_hidden_at', v_order.customer_hidden_at
  );
end;
$$;

create or replace function public.unarchive_order_admin(
  p_order_id bigint,
  p_actor uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_order public.ordenes%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'FORBIDDEN';
  end if;
  select rol into v_role from public.profiles where id = p_actor;
  if coalesce(v_role, '') <> 'super_admin' then
    raise exception 'ORDER_ARCHIVE_FORBIDDEN';
  end if;
  if length(v_reason) not between 5 and 500 then
    raise exception 'ORDER_ARCHIVE_REASON_REQUIRED';
  end if;

  select * into v_order from public.ordenes where id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if v_order.archived_at is null then
    raise exception 'ORDER_NOT_ARCHIVED';
  end if;

  perform set_config('beyonix.order_archive', 'on', true);
  update public.ordenes
  set archived_at = null, archived_by = null, archive_reason = null, customer_hidden_at = null
  where id = p_order_id
  returning * into v_order;
  perform set_config('beyonix.order_archive', '', true);

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (p_order_id, 'admin', p_actor, 'order_unarchived', v_order.estado, v_order.estado,
    jsonb_build_object('reason', v_reason));

  return jsonb_build_object('id', v_order.id, 'archived_at', null);
end;
$$;

revoke all on function public.order_delete_blockers_for_row(jsonb) from public, anon, authenticated;
revoke all on function public.order_delete_blockers(bigint) from public, anon, authenticated;
revoke all on function public.order_archive_blockers(bigint) from public, anon, authenticated;
revoke all on function public.guard_order_delete() from public, anon, authenticated;
revoke all on function public.archive_order_admin(bigint, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.unarchive_order_admin(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.order_delete_blockers(bigint) to service_role;
grant execute on function public.order_archive_blockers(bigint) to service_role;
grant execute on function public.archive_order_admin(bigint, uuid, text, boolean) to service_role;
grant execute on function public.unarchive_order_admin(bigint, uuid, text) to service_role;
