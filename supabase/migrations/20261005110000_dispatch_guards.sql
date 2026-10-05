-- Database-side cutover and live holds. These run on existing write paths,
-- including webhooks and legacy admin operations, before a UI exists.

-- Existing MP refunds are initiated by an admin. Record this explicitly so a
-- future assisted flow cannot silently reuse the same table after handover.
alter table public.mercadopago_order_refunds
  add column if not exists automation_mode text not null default 'admin_confirmed'
    check (automation_mode in ('admin_confirmed','automatic'));

create or replace function public.guard_andreani_handover()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.andreani_handed_over_at is not null and
     (new.andreani_handed_over_at is distinct from old.andreani_handed_over_at
      or new.andreani_handed_over_batch_id is distinct from old.andreani_handed_over_batch_id
      or new.andreani_handed_over_by is distinct from old.andreani_handed_over_by) then
    raise exception 'DISPATCH_HANDOVER_IMMUTABLE';
  end if;
  if new.andreani_handed_over_at is not null and old.andreani_handed_over_at is null then
    if not exists (
      select 1 from public.dispatch_batches b join public.dispatch_batch_items i on i.batch_id=b.id
      join public.order_packages p on p.id=i.package_id
      where b.id=new.andreani_handed_over_batch_id and b.status='handed_over'
        and b.handed_over_at=new.andreani_handed_over_at
        and i.order_id=new.id and i.removed_at is null
        and p.order_id=new.id and p.status='prepared'
    ) then raise exception 'DISPATCH_HANDOVER_INVALID_BATCH'; end if;
  end if;
  return new;
end $$;
create trigger guard_andreani_handover
  before update of andreani_handed_over_at,andreani_handed_over_batch_id,andreani_handed_over_by
  on public.ordenes for each row execute function public.guard_andreani_handover();

create or replace function public.refresh_order_dispatch_blocks()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform public.sync_dispatch_blocks(new.id);
  return new;
end $$;
create trigger refresh_order_dispatch_blocks
  after update of estado,financial_status,payment_status,paid_at,payment_confirmed_amount,
    invoice_status,invoice_cae,order_change_status,return_status,return_resolved_at,
    andreani_envio_id,andreani_creation_status,andreani_estado,
    shipping_provider,envio_proveedor,andreani_tracking_event_at,tracking_number,
    cancelled_at,andreani_handed_over_at
  on public.ordenes for each row execute function public.refresh_order_dispatch_blocks();

create or replace function public.lock_claim_order_for_dispatch()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform 1 from public.ordenes where id=new.order_id for update;
  return new;
end $$;
create trigger lock_claim_order_for_dispatch
  before insert or update of status,cancelled_at,failure_type on public.order_claims
  for each row execute function public.lock_claim_order_for_dispatch();

create or replace function public.refresh_claim_dispatch_blocks()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform public.sync_dispatch_blocks(coalesce(new.order_id,old.order_id));
  return coalesce(new,old);
end $$;
create trigger refresh_claim_dispatch_blocks
  after insert or update of status,cancelled_at,failure_type or delete on public.order_claims
  for each row execute function public.refresh_claim_dispatch_blocks();

create or replace function public.lock_item_order_for_dispatch()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_order_id bigint;
begin
  v_order_id := case when tg_op='DELETE' then old.orden_id else new.orden_id end;
  if exists (select 1 from public.order_packages where order_id=v_order_id) then
    perform 1 from public.ordenes where id=v_order_id for update;
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger lock_item_order_for_dispatch before insert or update or delete on public.orden_items
  for each row execute function public.lock_item_order_for_dispatch();

create or replace function public.refresh_item_dispatch_blocks()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform public.sync_dispatch_blocks(case when tg_op='DELETE' then old.orden_id else new.orden_id end);
  return case when tg_op='DELETE' then old else new end;
end $$;
create trigger refresh_item_dispatch_blocks after insert or update or delete on public.orden_items
  for each row execute function public.refresh_item_dispatch_blocks();

create or replace function public.guard_dispatch_refund_transition()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_handed_over_at timestamptz;
begin
  if new.automation_mode='automatic' then
    select andreani_handed_over_at into v_handed_over_at
      from public.ordenes where id=new.order_id for update;
    if v_handed_over_at is not null then raise exception 'DISPATCH_REFUND_AFTER_HANDOVER'; end if;
  end if;
  return new;
end $$;
create trigger guard_dispatch_refund_transition
  before insert or update of status,automation_mode on public.mercadopago_order_refunds
  for each row execute function public.guard_dispatch_refund_transition();

create or replace function public.refresh_refund_dispatch_blocks()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  perform public.sync_dispatch_blocks(new.order_id);
  return new;
end $$;
create trigger refresh_refund_dispatch_blocks
  after insert or update of status on public.mercadopago_order_refunds
  for each row execute function public.refresh_refund_dispatch_blocks();

-- A direct service-role update cannot forge a prepared package or bypass an
-- active batch relation. The RPCs remain the intended write surface.
create or replace function public.guard_package_prepared()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  if old.status='prepared' and new.status <> 'prepared'
     and current_setting('beyonix.dispatch_reset_order',true) is distinct from old.order_id::text then
    raise exception 'DISPATCH_PACKAGE_PREPARED_IMMUTABLE';
  end if;
  if new.status='prepared' and old.status<>'prepared' and
     (not exists (select 1 from public.order_preparation_lines where package_id=new.id)
      or exists (select 1 from public.order_preparation_lines
                 where package_id=new.id and scanned_quantity<>expected_quantity)) then
    raise exception 'DISPATCH_PACKAGE_INCOMPLETE';
  end if;
  return new;
end $$;
create trigger guard_package_prepared before update of status on public.order_packages
  for each row execute function public.guard_package_prepared();

create or replace function public.guard_dispatch_membership()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_status text;
begin
  select status into v_status from public.dispatch_batches where id=new.batch_id for update;
  if tg_op='INSERT' then
    if v_status<>'open' or not exists (select 1 from public.order_packages
        where id=new.package_id and order_id=new.order_id and status='prepared') then
      raise exception 'DISPATCH_MEMBERSHIP_INVALID'; end if;
  elsif old.removed_at is null and new.removed_at is not null then
    if v_status='handed_over' or length(btrim(coalesce(new.removal_reason,'')))<10
       or new.batch_id is distinct from old.batch_id
       or new.package_id is distinct from old.package_id
       or new.order_id is distinct from old.order_id
       or new.added_by is distinct from old.added_by
       or new.added_at is distinct from old.added_at then
      raise exception 'DISPATCH_REMOVAL_INVALID'; end if;
  elsif row(new.*) is distinct from row(old.*) then
    raise exception 'DISPATCH_MEMBERSHIP_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger guard_dispatch_membership before insert or update on public.dispatch_batch_items
  for each row execute function public.guard_dispatch_membership();

revoke all on function public.guard_andreani_handover(),
  public.refresh_order_dispatch_blocks(), public.lock_claim_order_for_dispatch(),
  public.refresh_claim_dispatch_blocks(), public.guard_dispatch_refund_transition(),
  public.refresh_refund_dispatch_blocks(), public.lock_item_order_for_dispatch(),
  public.refresh_item_dispatch_blocks(), public.guard_package_prepared(),
  public.guard_dispatch_membership() from public,anon,authenticated;
