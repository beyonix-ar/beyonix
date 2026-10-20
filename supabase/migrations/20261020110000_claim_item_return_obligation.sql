-- Obligación de devolución por producto en reclamos mixtos.
--
-- Antes, "Reenvío sin devolución" dispensaba la devolución de TODAS las
-- unidades del reclamo, también las de reintegro o saldo. Ahora cada línea del
-- reparto (order_claim_item_resolutions) dice cuántas de sus unidades deben
-- volver (return_quantity, 0..quantity); el resto queda con el cliente.
--
--   * Las unidades originales que no vuelven se registran "conservada_cliente"
--     apenas existen (sync_mixed_claim_original_units); las que deben volver
--     quedan "con_cliente" hasta el retiro, la recepción y la inspección.
--   * "Sin devolución" en un mixto sólo se usa si ninguna unidad debe volver.
--   * Dinero: un renglón de NC de una unidad que debe volver exige su producto
--     recibido e inspeccionado (o la excepción administrativa de siempre).
--   * Reemplazo: cada producto espera sólo su propia devolución.
--   * Cierre: no con una devolución obligatoria pendiente.
--
-- Reclamos simples e históricos: sin cambios (sus funciones conservan la
-- rama anterior). Producción no tiene reclamos mixtos todavía; las filas que
-- existieran quedan con devolución obligatoria (lo conservador).

begin;

alter table public.order_claim_item_resolutions add column if not exists return_quantity integer;
update public.order_claim_item_resolutions set return_quantity = quantity where return_quantity is null;
alter table public.order_claim_item_resolutions alter column return_quantity set not null;
alter table public.order_claim_item_resolutions drop constraint if exists order_claim_item_resolutions_return_quantity;
alter table public.order_claim_item_resolutions add constraint order_claim_item_resolutions_return_quantity
  check (return_quantity between 0 and quantity);

comment on column public.order_claim_item_resolutions.return_quantity is
  'Unidades de esta línea que deben volver a BEYONIX (recepción + inspección). El resto queda con el cliente.';

-- ¿Quedan unidades de este producto por volver? Con unidades registradas, lo
-- dice su paradero; antes de la logística, el reparto.
create or replace function public.order_claim_item_return_pending(p_claim_id bigint, p_order_item_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original')
      then exists (select 1 from public.order_claim_units
                   where claim_id = p_claim_id and role = 'original' and order_item_id = p_order_item_id
                     and location in ('con_cliente', 'en_andreani', 'recibida_beyonix'))
    else exists (select 1 from public.order_claim_item_resolutions
                 where claim_id = p_claim_id and order_item_id = p_order_item_id and return_quantity > 0)
  end
$$;

-- Una línea está libre de devolución si ninguna de sus unidades debe volver o
-- si su producto ya no tiene unidades pendientes de volver.
create or replace function public.order_claim_line_return_settled(p_claim_id bigint, p_order_item_id bigint, p_solution text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select return_quantity from public.order_claim_item_resolutions
                   where claim_id = p_claim_id and order_item_id = p_order_item_id and solution = p_solution), 0) = 0
    or not public.order_claim_item_return_pending(p_claim_id, p_order_item_id)
$$;

-- Las unidades que no vuelven quedan con el cliente (sólo hacia adelante: una
-- unidad que ya viaja o volvió nunca se marca como conservada).
create or replace function public.sync_mixed_claim_original_units(p_claim_id bigint, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_kept integer;
  v_moved integer;
begin
  if not exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original') then
    return;
  end if;
  for v_row in
    select order_item_id, sum(quantity - return_quantity)::integer keep
    from public.order_claim_item_resolutions where claim_id = p_claim_id
    group by order_item_id order by order_item_id
  loop
    select count(*) into v_kept from public.order_claim_units
    where claim_id = p_claim_id and role = 'original' and order_item_id = v_row.order_item_id and location = 'conservada_cliente';
    if v_row.keep > v_kept then
      update public.order_claim_units set location = 'conservada_cliente', updated_at = clock_timestamp()
      where id in (select id from public.order_claim_units
                   where claim_id = p_claim_id and role = 'original' and order_item_id = v_row.order_item_id
                     and location = 'con_cliente' and shipment_id is null
                   order by id desc limit v_row.keep - v_kept);
      get diagnostics v_moved = row_count;
      if v_moved < v_row.keep - v_kept then raise exception 'CLAIM_RETURN_ALREADY_STARTED'; end if;
      perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_original_return_waived',
        jsonb_build_object('mode', 'item_resolution', 'orderItemId', v_row.order_item_id, 'quantity', v_moved));
    end if;
  end loop;
end;
$$;

-- Unidades originales: las que no vuelven quedan con el cliente -------------

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
    -- Reclamo mixto: las unidades sin devolución quedan con el cliente.
    if p_claim.resolution = 'mixta' then perform public.sync_mixed_claim_original_units(p_claim.id, null); end if;
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
  if p_claim.resolution = 'mixta' then perform public.sync_mixed_claim_original_units(p_claim.id, null); end if;
  return v_count;
end;
$$;

-- Dinero: sólo frenan las unidades de reintegro/saldo que deben volver ------

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
    -- Reclamo mixto: sólo frenan el dinero las unidades de reintegro o saldo
    -- que deben volver (las de reemplazo o sin devolución, no).
    when exists (select 1 from public.order_claims where id = p_claim_id and resolution = 'mixta')
      then case when exists (
        select 1 from public.order_claim_item_resolutions r
        where r.claim_id = p_claim_id and r.solution in ('refund', 'credit') and r.return_quantity > 0
          and public.order_claim_item_return_pending(p_claim_id, r.order_item_id)
      ) then 'CLAIM_MONEY_RETURN_PENDING' end
    when exists (select 1 from public.order_claim_units
                 where claim_id = p_claim_id and role = 'original'
                   and location in ('con_cliente', 'en_andreani', 'recibida_beyonix'))
      then 'CLAIM_MONEY_RETURN_PENDING'
  end
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
  -- Mismo lock que la logística (begin_partial_credit_note ya lo tiene: no-op):
  -- una NC nunca se cruza con un cambio de método en curso.
  perform 1 from public.order_claims where id = new.claim_id for update;
  v_block := public.order_claim_money_block(new.claim_id);
  -- Reclamo mixto: la devolución se exige por producto en cada renglón
  -- (guard_mixed_claim_credit_note_item); acá sólo la incidencia y la
  -- excepción administrativa explícita (si existe, queda ligada a esta NC).
  if exists (select 1 from public.order_claims where id = new.claim_id and resolution = 'mixta') then
    if v_block = 'CLAIM_MONEY_INCIDENT_OPEN' then raise exception 'CLAIM_MONEY_INCIDENT_OPEN'; end if;
    if v_block is not null then
      update public.order_claim_financial_exceptions
      set consumed_at = clock_timestamp(), credit_note_id = new.id
      where id = (select id from public.order_claim_financial_exceptions
                  where claim_id = new.claim_id and consumed_at is null order by id limit 1 for update)
      returning id into v_exception;
      if v_exception is not null then
        perform public.log_order_claim_logistics(new.claim_id, new.created_by, 'claim_financial_exception_used',
          jsonb_build_object('exceptionId', v_exception, 'creditNoteId', new.id));
      end if;
    end if;
    return new;
  end if;
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
  if exists (
    select 1 from public.order_claims c
    join public.order_claim_item_resolutions r on r.claim_id = c.id and r.solution = 'credit'
    where c.order_id = p_order_id and c.resolution = 'mixta' and c.status not in ('cerrado', 'rechazado')
      and r.quantity > public.order_claim_credited_quantity(c.id, r.order_item_id, 'customer_balance', false)
  ) then
    raise exception 'CLAIM_MIXED_CREDIT_FIRST';
  end if;
  -- Un mixto exige la devolución definida por producto aunque todavía no haya unidades.
  select c.id into v_claim_id from public.order_claims c
  where c.order_id = p_order_id and c.status not in ('cerrado', 'rechazado')
    and (c.resolution = 'mixta' or exists (select 1 from public.order_claim_units u where u.claim_id = c.id))
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

create or replace function public.guard_mixed_claim_credit_note_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note public.order_credit_notes%rowtype;
  v_solution text;
begin
  select * into v_note from public.order_credit_notes where id = new.credit_note_id;
  if v_note.claim_id is null then return new; end if;
  if not exists (select 1 from public.order_claims where id = v_note.claim_id and resolution = 'mixta') then
    return new;
  end if;
  v_solution := case v_note.destination when 'external_refund' then 'refund' when 'customer_balance' then 'credit' end;
  if v_solution is null
     or coalesce(new.quantity, 0) <= 0
     or public.order_claim_credited_quantity(v_note.claim_id, new.order_item_id, v_note.destination, false) + new.quantity
        > public.order_claim_line_quantity(v_note.claim_id, new.order_item_id, v_solution) then
    raise exception 'INVALID_CREDIT_NOTE_CLAIM_ITEM';
  end if;
  -- Una unidad que debe volver sólo se reintegra o acredita recibida e
  -- inspeccionada (o con la excepción administrativa ligada a esta NC).
  if not public.order_claim_line_return_settled(v_note.claim_id, new.order_item_id, v_solution)
     and not exists (select 1 from public.order_claim_financial_exceptions where credit_note_id = v_note.id) then
    raise exception 'CLAIM_MONEY_RETURN_PENDING';
  end if;
  return new;
end;
$$;

-- Reemplazo: cada producto espera sólo su propia devolución -----------------

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

  -- Reclamo mixto: cada producto a reemplazar espera sólo su propia devolución
  -- (si la tiene); un producto sin devolución sale sin esperar a los demás.
  if exists (select 1 from public.order_claims where id = p_leg.claim_id and resolution = 'mixta') then
    if not exists (select 1 from public.order_claim_units
                   where claim_id = p_leg.claim_id and role = 'reemplazo' and location = 'reservada'
                     and (shipment_id is null or shipment_id = p_leg.id)) then
      return 'CLAIM_SHIPMENT_NOT_READY_RESERVATION';
    end if;
    if exists (select 1 from public.order_claim_units u
               where u.claim_id = p_leg.claim_id and u.role = 'reemplazo' and u.location = 'reservada'
                 and (u.shipment_id is null or u.shipment_id = p_leg.id)
                 and not public.order_claim_line_return_settled(p_leg.claim_id, u.order_item_id, 'replacement')) then
      return 'CLAIM_SHIPMENT_NOT_READY_RECEPTION';
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
  v_plan_change boolean := false;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_direction not in ('devolucion', 'cambio', 'reemplazo') then raise exception 'CLAIM_SHIPMENT_INVALID'; end if;
  if v_branch_id is null then raise exception 'CLAIM_LOGISTICS_BRANCH_REQUIRED'; end if;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if not public.order_claim_is_accepted(v_claim) then raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED'; end if;
  if p_direction = 'devolucion'
     and v_claim.resolution not in ('cambio_producto', 'reintegro_total', 'reintegro_parcial', 'saldo_a_favor', 'cupon_descuento', 'mixta') then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;
  if p_direction = 'cambio' and v_claim.resolution <> 'cambio_producto' then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;
  if p_direction = 'reemplazo' and not public.order_claim_includes_replacement(v_claim) then
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
  if p_direction = 'reemplazo' and v_claim.resolution = 'mixta' then
    -- Mixto: alcanza con un producto a reemplazar listo (sin devolución, o
    -- con la suya recibida e inspeccionada); cada uno espera sólo lo suyo.
    if not exists (select 1 from public.order_claim_item_resolutions r
                   where r.claim_id = p_claim_id and r.solution = 'replacement'
                     and public.order_claim_line_return_settled(p_claim_id, r.order_item_id, 'replacement')) then
      raise exception 'CLAIM_LOGISTICS_REQUIRES_INSPECTION';
    end if;
  elsif p_direction = 'reemplazo' then
    -- Nunca antes de la inspección: sólo después de un retiro generado
    -- (Retiro + revisión) o con la devolución dispensada explícitamente.
    if not (
      (v_current_plan = 'retiro' and exists (select 1 from public.order_claim_shipments
         where claim_id = p_claim_id and direction = 'devolucion' and status <> 'cancelada' and creation_status = 'created'))
      or public.order_claim_return_waived(p_claim_id)
    ) then
      raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
    end if;
    if not public.order_claim_originals_inspected(p_claim_id) then raise exception 'CLAIM_LOGISTICS_REQUIRES_INSPECTION'; end if;
  elsif v_current_plan is not null and v_current_plan <> v_new_plan then
    v_plan_change := true;
    if exists (
      select 1 from public.order_claim_shipments
      where claim_id = p_claim_id and status <> 'cancelada' and creation_status in ('processing', 'created', 'manual_review')
    ) then
      if length(v_note) < 10 then raise exception 'CLAIM_LOGISTICS_PLAN_LOCKED'; end if;
      perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_plan_changed',
        jsonb_build_object('from', v_current_plan, 'to', v_new_plan, 'notes', left(v_note, 1000)));
    end if;
  end if;

  select * into v_open from public.order_claim_shipments where claim_id = p_claim_id and closed_at is null
  order by legacy desc, id desc limit 1 for update;
  if found then
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

  if v_plan_change then
    if exists (select 1 from public.order_claim_units
               where claim_id = p_claim_id and role = 'reemplazo' and location = 'reservada') then
      raise exception 'CLAIM_LOGISTICS_RESERVATION_ACTIVE';
    end if;
    if exists (select 1 from public.order_credit_notes
               where claim_id = p_claim_id and status in ('processing', 'authorized')) then
      raise exception 'CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE';
    end if;
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

create or replace function public.request_order_claim_resend_without_return(
  p_claim_id bigint,
  p_actor_id uuid,
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
  v_note text := btrim(coalesce(p_note, ''));
  v_count integer;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if length(v_note) < 10 then raise exception 'CLAIM_LOGISTICS_NOTE_REQUIRED'; end if;
  if nullif(btrim(coalesce(p_branch_id, '')), '') is null then raise exception 'CLAIM_LOGISTICS_BRANCH_REQUIRED'; end if;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if not public.order_claim_is_accepted(v_claim) or not public.order_claim_includes_replacement(v_claim) then
    raise exception 'CLAIM_LOGISTICS_NOT_ALLOWED';
  end if;

  -- Reclamo mixto: la devolución se define por producto al aprobar. "Sin
  -- devolución" nunca dispensa unidades que deben volver (reintegro, saldo o
  -- un reemplazo con devolución): con alguna pendiente, primero el retiro.
  if v_claim.resolution = 'mixta' then
    perform public.ensure_order_claim_original_units(v_claim);
    if exists (select 1 from public.order_claim_units
               where claim_id = p_claim_id and role = 'original' and location in ('con_cliente', 'en_andreani', 'recibida_beyonix')) then
      raise exception 'CLAIM_RETURN_REQUIRED';
    end if;
    return public.request_order_claim_logistics(p_claim_id, p_actor_id, 'reemplazo', v_note, p_branch_id, p_branch_name, p_branch_address);
  end if;

  -- Reintento: la devolución ya se dispensó; request_order_claim_logistics
  -- devuelve el tramo abierto (o abre el siguiente intento).
  if public.order_claim_return_waived(p_claim_id) then
    return public.request_order_claim_logistics(p_claim_id, p_actor_id, 'reemplazo', v_note, p_branch_id, p_branch_name, p_branch_address);
  end if;

  if v_claim.logistics_legacy and (
    exists (select 1 from public.order_replacements where claim_id = p_claim_id)
    or exists (
      select 1 from public.inventory_return_movements m
      where m.order_id = v_claim.order_id and m.created_at >= v_claim.created_at
        and m.order_item_id in (select (x->>'order_item_id')::bigint from jsonb_array_elements(v_claim.affected_items) x)
    )
  ) then
    raise exception 'CLAIM_LOGISTICS_LEGACY';
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
     or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and review_required) then
    raise exception 'CLAIM_LOGISTICS_INCIDENT';
  end if;
  if exists (select 1 from public.order_claim_shipments
             where claim_id = p_claim_id and status <> 'cancelada' and creation_status in ('processing', 'created', 'manual_review')) then
    raise exception 'CLAIM_RETURN_ALREADY_STARTED';
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'reemplazo') then
    raise exception 'CLAIM_LOGISTICS_RESERVATION_ACTIVE';
  end if;
  if exists (select 1 from public.order_credit_notes where claim_id = p_claim_id and status in ('processing', 'authorized')) then
    raise exception 'CLAIM_LOGISTICS_CREDIT_NOTE_ACTIVE';
  end if;

  -- Un tramo pendiente que nunca llegó a Andreani se cancela (auditado).
  select * into v_open from public.order_claim_shipments
  where claim_id = p_claim_id and closed_at is null order by id desc limit 1 for update;
  if found then
    if v_open.legacy or v_open.status <> 'pendiente' or v_open.creation_status not in ('not_started', 'failed') then
      raise exception 'CLAIM_LOGISTICS_OPEN';
    end if;
    update public.order_claim_shipments
    set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = v_open.id;
    perform public.release_order_claim_leg_units(v_open.id);
    perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_logistics_cancelled',
      jsonb_build_object('shipmentId', v_open.id, 'direction', v_open.direction, 'reason', 'return_waived',
        'notes', left(v_note, 1000)));
  end if;

  perform public.ensure_order_claim_original_units(v_claim);
  if exists (select 1 from public.order_claim_units
             where claim_id = p_claim_id and role = 'original' and location <> 'con_cliente') then
    raise exception 'CLAIM_RETURN_ALREADY_STARTED';
  end if;
  update public.order_claim_units set location = 'conservada_cliente', updated_at = clock_timestamp()
  where claim_id = p_claim_id and role = 'original' and location = 'con_cliente';
  get diagnostics v_count = row_count;
  perform public.log_order_claim_logistics(p_claim_id, p_actor_id, 'claim_original_return_waived',
    jsonb_build_object('mode', 'before_resend', 'quantity', v_count, 'notes', left(v_note, 1000)));
  perform public.post_order_claim_system_message(p_claim_id, 'resend_without_return',
    'No hace falta que devuelvas el producto. Te vamos a enviar el reemplazo a una sucursal Andreani y te avisamos cuando esté en camino.');

  return public.request_order_claim_logistics(p_claim_id, p_actor_id, 'reemplazo', v_note, p_branch_id, p_branch_name, p_branch_address);
end;
$$;

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
  v_waived boolean := false;
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
    select * into v_claim from public.order_claims where id = p_claim_id and order_id = p_original_order_id for update;
    if not found or v_claim.status in ('recibido','en_revision','falta_informacion','cerrado','rechazado')
       or coalesce(v_claim.resolution, '') not in ('cambio_producto', 'envio_unidad_faltante', 'mixta') then
      raise exception 'REPLACEMENT_INVALID_CLAIM';
    end if;
    if v_claim.resolution = 'mixta' then
      v_claimed := nullif(public.order_claim_line_quantity(p_claim_id, p_original_order_item_id, 'replacement'), 0);
    else
      select sum((x->>'quantity')::integer) into v_claimed from jsonb_array_elements(v_claim.affected_items) x
      where (x->>'order_item_id')::bigint = p_original_order_item_id;
    end if;
    if v_claimed is null then raise exception 'REPLACEMENT_INVALID_ITEM'; end if;
    if exists (select 1 from public.order_claim_shipments
               where claim_id = p_claim_id and closed_at is null and direction in ('cambio', 'reemplazo')
                 and creation_status in ('processing', 'created', 'manual_review')) then
      raise exception 'REPLACEMENT_LOGISTICS_LOCKED';
    end if;
    v_exchange := exists (select 1 from public.order_claim_shipments
                          where claim_id = p_claim_id and closed_at is null and direction = 'cambio' and status = 'pendiente');
    v_waived := public.order_claim_return_waived(p_claim_id);
    if not v_claim.logistics_legacy and v_claim.resolution in ('cambio_producto', 'mixta')
       and coalesce(v_claim.failure_type, '') not in ('faltante', 'cantidad_menor')
       and not exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original') then
      raise exception 'REPLACEMENT_REQUIRES_PLAN';
    end if;
    if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and role = 'original') then
      if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open) then
        raise exception 'REPLACEMENT_REQUIRES_INSPECTION';
      end if;
      if not exists (select 1 from public.order_claim_shipments
                     where claim_id = p_claim_id and closed_at is null and status = 'pendiente'
                       and direction in ('cambio', 'reemplazo')) then
        raise exception 'REPLACEMENT_REQUIRES_PLAN';
      end if;
      if v_claim.resolution = 'mixta' then
        -- Mixto: sólo espera la devolución de su propio producto (si la tiene).
        if not public.order_claim_line_return_settled(p_claim_id, p_original_order_item_id, 'replacement') then
          raise exception 'REPLACEMENT_REQUIRES_INSPECTION';
        end if;
      elsif exists (select 1 from public.order_claim_shipments
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
  if p_reason <> 'garantia' and not v_exchange and not v_waived and coalesce(v_claim.resolution, '') <> 'mixta'
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

-- Reparto, cambio por falta de stock y cierre -------------------------------

create or replace function public.set_order_claim_item_resolutions(
  p_claim_id bigint,
  p_actor_id uuid,
  p_expected_updated_at timestamptz,
  p_lines jsonb,
  p_message text default null
)
returns public.order_claims
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_claim public.order_claims%rowtype;
  v_line jsonb;
  v_initial boolean;
  v_message text := btrim(coalesce(p_message, ''));
  v_claimed_total integer;
  v_lines_total integer;
  v_status text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'CLAIM_FORBIDDEN'; end if;
  select rol into v_role from public.profiles where id = p_actor_id;
  if coalesce(v_role, '') not in ('admin', 'super_admin') then raise exception 'CLAIM_FORBIDDEN'; end if;
  if length(v_message) > 2000 then raise exception 'CLAIM_INVALID'; end if;
  perform 1 from public.ordenes where id = (select order_id from public.order_claims where id = p_claim_id) for update;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if p_expected_updated_at is null or v_claim.updated_at <> p_expected_updated_at then raise exception 'CLAIM_CONFLICT'; end if;
  if v_claim.status in ('cerrado', 'rechazado') then raise exception 'CLAIM_TERMINAL'; end if;
  if coalesce(v_claim.failure_type, '') in ('consulta_pedido', 'cancelar_compra') then raise exception 'CLAIM_INVALID'; end if;

  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'CLAIM_RESOLUTION_INVALID_LINES';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or coalesce(v_line->>'solution', '') not in ('replacement', 'refund', 'credit')
       or coalesce(v_line->>'order_item_id', '') !~ '^[0-9]{1,18}$'
       or coalesce(v_line->>'quantity', '') !~ '^[0-9]{1,6}$'
       or (v_line->>'quantity')::integer <= 0
       or (v_line ? 'return_quantity' and (coalesce(v_line->>'return_quantity', '') !~ '^[0-9]{1,6}$'
           or (v_line->>'return_quantity')::integer > (v_line->>'quantity')::integer)) then
      raise exception 'CLAIM_RESOLUTION_INVALID_LINES';
    end if;
  end loop;
  if (select count(distinct (x->>'order_item_id') || ':' || (x->>'solution')) from jsonb_array_elements(p_lines) x)
     <> jsonb_array_length(p_lines) then
    raise exception 'CLAIM_RESOLUTION_INVALID_LINES';
  end if;

  if v_claim.status in ('recibido', 'en_revision', 'falta_informacion') then
    v_initial := true;
  elsif public.order_claim_is_accepted(v_claim) and v_claim.resolution = 'mixta' then
    v_initial := false;
  elsif public.order_claim_is_accepted(v_claim) then
    -- Una solución simple aprobada pasa a mixta sólo sin efectos reales
    -- (la logística la vuelve a validar guard_order_claim_logistics).
    if exists (select 1 from public.order_credit_notes where claim_id = v_claim.id and status in ('processing', 'authorized'))
       or exists (select 1 from public.order_replacements where claim_id = v_claim.id and quantity > reverted_quantity) then
      raise exception 'CLAIM_RESOLUTION_LOCKED';
    end if;
    v_initial := true;
  else
    raise exception 'CLAIM_INVALID';
  end if;

  if v_initial then
    select coalesce(sum((x->>'quantity')::integer), 0) into v_claimed_total
    from jsonb_array_elements(coalesce(v_claim.affected_items, '[]'::jsonb)) x;
    select coalesce(sum((x->>'quantity')::integer), 0) into v_lines_total from jsonb_array_elements(p_lines) x;
    if (select count(distinct x->>'solution') from jsonb_array_elements(p_lines) x) < 2
       and v_lines_total >= v_claimed_total then
      raise exception 'CLAIM_RESOLUTION_NOT_MIXED';
    end if;
    delete from public.order_claim_item_resolutions where claim_id = v_claim.id;
  elsif exists (
    select 1 from public.order_claim_item_resolutions r
    -- Nada se reduce: ni unidades, ni devoluciones, ni unidades que el cliente conserva.
    left join lateral (
      select (x->>'quantity')::integer q, coalesce((x->>'return_quantity')::integer, (x->>'quantity')::integer) rq
      from jsonb_array_elements(p_lines) x
      where (x->>'order_item_id')::bigint = r.order_item_id and x->>'solution' = r.solution
    ) n on true
    where r.claim_id = v_claim.id
      and (coalesce(n.q, 0) < r.quantity or coalesce(n.rq, 0) < r.return_quantity
        or coalesce(n.q, 0) - coalesce(n.rq, 0) < r.quantity - r.return_quantity)
  ) then
    raise exception 'CLAIM_RESOLUTION_LOCKED';
  end if;

  -- El trigger valida ítem y suma por ítem contra lo reclamado. Primero crecen
  -- las filas existentes (nunca bajan) y después se agregan las nuevas: cada
  -- suma parcial queda por debajo de la final.
  update public.order_claim_item_resolutions r
  set quantity = (x->>'quantity')::integer,
      return_quantity = coalesce((x->>'return_quantity')::integer, (x->>'quantity')::integer),
      updated_by = p_actor_id
  from jsonb_array_elements(p_lines) x
  where r.claim_id = v_claim.id and r.order_item_id = (x->>'order_item_id')::bigint and r.solution = x->>'solution'
    and (r.quantity, r.return_quantity) is distinct from
        ((x->>'quantity')::integer, coalesce((x->>'return_quantity')::integer, (x->>'quantity')::integer));
  insert into public.order_claim_item_resolutions (claim_id, order_item_id, solution, quantity, return_quantity, created_by, updated_by)
  select v_claim.id, (x->>'order_item_id')::bigint, x->>'solution', (x->>'quantity')::integer,
    coalesce((x->>'return_quantity')::integer, (x->>'quantity')::integer), p_actor_id, p_actor_id
  from jsonb_array_elements(p_lines) x
  where not exists (select 1 from public.order_claim_item_resolutions r
                    where r.claim_id = v_claim.id and r.order_item_id = (x->>'order_item_id')::bigint and r.solution = x->>'solution');

  v_status := case when v_claim.status in ('recibido', 'en_revision', 'falta_informacion', 'cambio_pendiente', 'cupon_pendiente', 'reintegro_pendiente')
    then 'aprobado' else v_claim.status end;
  update public.order_claims
  set status = v_status,
      resolution = 'mixta',
      admin_response = case when length(v_message) > 0 then v_message else admin_response end,
      first_reviewed_at = case when v_claim.status = 'recibido' then now() else first_reviewed_at end,
      first_reviewed_by = case when v_claim.status = 'recibido' then p_actor_id else first_reviewed_by end,
      admin_needs_action = false,
      updated_at = clock_timestamp()
  where id = v_claim.id;
  -- Con la logística ya iniciada, las unidades sin devolución quedan con el cliente.
  perform public.sync_mixed_claim_original_units(v_claim.id, p_actor_id);

  if v_initial then
    perform public.post_order_claim_system_message(v_claim.id, 'mixed_resolution_approved',
      'BEYONIX aprobó tu reclamo con una solución para cada producto. Podés ver el detalle en este reclamo.');
  end if;
  if length(v_message) > 0 then
    insert into public.order_claim_messages (claim_id, author_user_id, author_role, message)
    values (v_claim.id, p_actor_id, v_role, v_message);
  end if;

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (v_claim.order_id, 'admin', p_actor_id, 'claim_item_resolutions_set', v_claim.status, v_status,
    jsonb_build_object('claimId', v_claim.id, 'previousResolution', v_claim.resolution, 'newResolution', 'mixta',
      'mode', case when v_initial then 'define' else 'add' end,
      'lines', (select jsonb_agg(jsonb_build_object('orderItemId', order_item_id, 'solution', solution, 'quantity', quantity, 'returnQuantity', return_quantity) order by order_item_id, solution)
                from public.order_claim_item_resolutions where claim_id = v_claim.id)));

  select * into v_claim from public.order_claims where id = v_claim.id;
  return v_claim;
end;
$$;

create or replace function public.switch_order_claim_replacement_resolution(
  p_claim_id bigint,
  p_actor_id uuid,
  p_expected_updated_at timestamptz,
  p_order_item_id bigint,
  p_target text,
  p_note text default null
)
returns public.order_claims
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_items bigint[];
  v_item bigint;
  v_active integer;
  v_releasable integer;
  v_quantity integer := 0;
  v_return integer;
  v_to text;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
  v_label text;
begin
  perform public.assert_order_claim_logistics_admin(p_actor_id);
  if p_target not in ('refund', 'credit') then raise exception 'CLAIM_INVALID'; end if;
  perform 1 from public.ordenes where id = (select order_id from public.order_claims where id = p_claim_id) for update;
  select * into v_claim from public.order_claims where id = p_claim_id for update;
  if not found then raise exception 'CLAIM_NOT_FOUND'; end if;
  if p_expected_updated_at is null or v_claim.updated_at <> p_expected_updated_at then raise exception 'CLAIM_CONFLICT'; end if;
  if not public.order_claim_is_accepted(v_claim) then raise exception 'CLAIM_INVALID'; end if;

  if v_claim.resolution in ('cambio_producto', 'envio_unidad_faltante') then
    select array_agg(distinct (x->>'order_item_id')::bigint) into v_items
    from jsonb_array_elements(coalesce(v_claim.affected_items, '[]'::jsonb)) x;
  elsif v_claim.resolution = 'mixta' then
    if p_order_item_id is null or public.order_claim_line_quantity(p_claim_id, p_order_item_id, 'replacement') = 0 then
      raise exception 'CLAIM_RESOLUTION_INVALID_ITEM';
    end if;
    v_items := array[p_order_item_id];
  else
    raise exception 'CLAIM_INVALID';
  end if;

  -- Irreversible: un envío del reemplazo iniciado (o ya generado) o una unidad
  -- de reemplazo que salió de la reserva.
  if exists (select 1 from public.order_claim_shipments
             where claim_id = p_claim_id and direction in ('cambio', 'reemplazo') and status <> 'cancelada'
               and creation_status in ('processing', 'created', 'manual_review'))
     or exists (select 1 from public.order_claim_units
                where claim_id = p_claim_id and role = 'reemplazo' and order_item_id = any (v_items)
                  and (location in ('en_andreani', 'entregada_cliente', 'recibida_beyonix')
                       or (location = 'reservada' and shipment_id is not null))) then
    raise exception 'CLAIM_REPLACEMENT_ALREADY_SHIPPED';
  end if;
  if exists (select 1 from public.order_claim_units where claim_id = p_claim_id and incident_open)
     or exists (select 1 from public.order_claim_shipments where claim_id = p_claim_id and review_required) then
    raise exception 'CLAIM_LOGISTICS_INCIDENT';
  end if;

  -- La reserva vigente tiene que poder liberarse completa (stock de vuelta).
  foreach v_item in array v_items loop
    select coalesce(sum(quantity - reverted_quantity), 0) into v_active
    from public.order_replacements where claim_id = p_claim_id and original_order_item_id = v_item;
    select count(*) into v_releasable from public.order_claim_units
    where claim_id = p_claim_id and role = 'reemplazo' and order_item_id = v_item
      and location = 'reservada' and shipment_id is null;
    if v_active > v_releasable then raise exception 'CLAIM_REPLACEMENT_NOT_REVERSIBLE'; end if;
    if v_releasable > 0 then
      perform public.release_order_claim_replacement_reservation(p_claim_id, p_actor_id, v_item, v_releasable,
        'Reserva liberada: resolución cambiada por falta de stock.',
        'stock-switch:' || p_claim_id || ':' || v_item || ':' || extract(epoch from v_claim.updated_at)::text);
    end if;
  end loop;

  v_label := 'Resolución cambiada de Reemplazo a ' || case when p_target = 'refund' then 'Reintegro' else 'Saldo a favor' end || ' por falta de stock';

  if v_claim.resolution = 'mixta' then
    select quantity, return_quantity into v_quantity, v_return from public.order_claim_item_resolutions
    where claim_id = p_claim_id and order_item_id = p_order_item_id and solution = 'replacement';
    delete from public.order_claim_item_resolutions
    where claim_id = p_claim_id and order_item_id = p_order_item_id and solution = 'replacement';
    -- La obligación de devolver esas unidades no cambia con la solución.
    insert into public.order_claim_item_resolutions (claim_id, order_item_id, solution, quantity, return_quantity, created_by, updated_by)
    values (p_claim_id, p_order_item_id, p_target, v_quantity, v_return, p_actor_id, p_actor_id)
    on conflict (claim_id, order_item_id, solution) do update
      set quantity = public.order_claim_item_resolutions.quantity + excluded.quantity,
          return_quantity = public.order_claim_item_resolutions.return_quantity + excluded.return_quantity,
          updated_by = excluded.updated_by;
    -- Sin unidades a reemplazar, el envío pendiente (nunca generado) ya no corresponde.
    if not exists (select 1 from public.order_claim_item_resolutions where claim_id = p_claim_id and solution = 'replacement') then
      update public.order_claim_shipments
      set status = 'cancelada', closed_at = clock_timestamp(), updated_at = clock_timestamp()
      where claim_id = p_claim_id and closed_at is null and direction in ('cambio', 'reemplazo')
        and creation_status in ('not_started', 'failed');
    end if;
    update public.order_claims set updated_at = clock_timestamp() where id = p_claim_id;
  else
    select coalesce(sum((x->>'quantity')::integer), 0) into v_quantity
    from jsonb_array_elements(coalesce(v_claim.affected_items, '[]'::jsonb)) x;
    v_to := case when p_target = 'refund' then 'reintegro_total' else 'saldo_a_favor' end;
    -- Habilita, sólo en esta transacción, el cambio de resolución con la
    -- devolución ya iniciada (guard_order_claim_logistics).
    perform set_config('beyonix.claim_resolution_switch', p_claim_id::text, true);
    update public.order_claims
    set resolution = v_to, status = 'aprobado', admin_needs_action = false, updated_at = clock_timestamp()
    where id = p_claim_id;
    perform set_config('beyonix.claim_resolution_switch', '', true);
  end if;

  insert into public.order_audit_events (order_id, actor_type, actor_id, action, previous_status, new_status, metadata)
  values (v_claim.order_id, 'admin', p_actor_id, 'claim_resolution_switched', v_claim.status,
    (select status from public.order_claims where id = p_claim_id),
    jsonb_build_object('claimId', p_claim_id, 'from', 'replacement', 'to', p_target, 'reason', 'sin_stock',
      'label', v_label, 'orderItemId', p_order_item_id, 'quantity', v_quantity,
      'previousResolution', v_claim.resolution,
      'newResolution', (select resolution from public.order_claims where id = p_claim_id),
      'notes', nullif(v_note, '')));
  perform public.post_order_claim_system_message(p_claim_id,
    'resolution_switched_' || p_target || '_' || coalesce(p_order_item_id, 0),
    case when p_target = 'refund'
      then 'No tenemos stock para reemplazar el producto. Vamos a resolver tu reclamo con el reintegro del dinero correspondiente.'
      else 'No tenemos stock para reemplazar el producto. Vamos a acreditar el valor correspondiente como saldo a favor en tu cuenta BEYONIX para que puedas elegir otro producto.' end);

  select * into v_claim from public.order_claims where id = p_claim_id;
  return v_claim;
end;
$$;

create or replace function public.order_claim_mixed_blockers(p_claim public.order_claims)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[
    case when exists (
      select 1 from jsonb_array_elements(coalesce(p_claim.affected_items, '[]'::jsonb)) x
      where (x->>'quantity')::integer > coalesce((
        select sum(r.quantity) from public.order_claim_item_resolutions r
        where r.claim_id = p_claim.id and r.order_item_id = (x->>'order_item_id')::bigint), 0)
    ) then 'CLAIM_MIXED_UNRESOLVED_UNITS' end,
    case when exists (
      select 1 from public.order_claim_item_resolutions r
      where r.claim_id = p_claim.id and r.return_quantity > 0
        and public.order_claim_item_return_pending(p_claim.id, r.order_item_id)
    ) then 'CLAIM_MIXED_RETURN_PENDING' end,
    case when exists (
      select 1 from public.order_claim_item_resolutions r
      where r.claim_id = p_claim.id and r.solution = 'replacement'
        and r.quantity > coalesce((
          select sum(o.quantity - o.reverted_quantity) from public.order_replacements o
          where o.claim_id = p_claim.id and o.original_order_item_id = r.order_item_id), 0)
    ) then 'CLAIM_MIXED_REPLACEMENT_PENDING' end,
    case when exists (
      select 1 from public.order_claim_item_resolutions r
      where r.claim_id = p_claim.id and r.solution = 'refund'
        and r.quantity > public.order_claim_credited_quantity(p_claim.id, r.order_item_id, 'external_refund', true)
    ) then 'CLAIM_MIXED_REFUND_PENDING' end,
    case when exists (
      select 1 from public.order_claim_item_resolutions r
      where r.claim_id = p_claim.id and r.solution = 'credit'
        and r.quantity > public.order_claim_credited_quantity(p_claim.id, r.order_item_id, 'customer_balance', true)
    ) then 'CLAIM_MIXED_CREDIT_PENDING' end
  ]::text[], null)
$$;

revoke all on function public.order_claim_item_return_pending(bigint, bigint) from public, anon, authenticated;
revoke all on function public.order_claim_line_return_settled(bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.sync_mixed_claim_original_units(bigint, uuid) from public, anon, authenticated;
revoke all on function public.ensure_order_claim_original_units(public.order_claims) from public, anon, authenticated;
revoke all on function public.order_claim_money_block(bigint) from public, anon, authenticated;
revoke all on function public.guard_claim_credit_note() from public, anon, authenticated;
revoke all on function public.order_claim_leg_readiness(public.order_claim_shipments) from public, anon, authenticated;
revoke all on function public.assert_order_claim_money_released(bigint) from public, anon, authenticated;
revoke all on function public.order_claim_mixed_blockers(public.order_claims) from public, anon, authenticated;
revoke all on function public.guard_mixed_claim_credit_note_item() from public, anon, authenticated;
revoke all on function public.set_order_claim_item_resolutions(bigint, uuid, timestamptz, jsonb, text) from public, anon, authenticated;
grant execute on function public.set_order_claim_item_resolutions(bigint, uuid, timestamptz, jsonb, text) to service_role;
revoke all on function public.switch_order_claim_replacement_resolution(bigint, uuid, timestamptz, bigint, text, text) from public, anon, authenticated;
grant execute on function public.switch_order_claim_replacement_resolution(bigint, uuid, timestamptz, bigint, text, text) to service_role;
revoke all on function public.request_order_claim_logistics(bigint, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_order_claim_logistics(bigint, uuid, text, text, text, text, text) to service_role;
revoke all on function public.request_order_claim_resend_without_return(bigint, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_order_claim_resend_without_return(bigint, uuid, text, text, text, text) to service_role;
revoke all on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.create_order_replacement(bigint,bigint,bigint,integer,text,uuid,text,text,text,bigint) to service_role;

notify pgrst, 'reload schema';

commit;
