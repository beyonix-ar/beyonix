-- Auditoría 3/7 (compras/reposición/costos), cierre final. Reemplaza el
-- diseño "lazy" de 20260918140000 (que congelaba costo_unitario_historico
-- recién cuando alguien abría el dashboard o el listado de Mercado Libre --
-- rechazado por no ser un choke point determinístico) por congelamiento
-- SERVER-SIDE, IDEMPOTENTE, en el momento exacto en que cada canal reconoce
-- la venta como definitiva:
--
--   A. Venta web (orden_items): cuando la orden pasa a un estado que
--      `inventory_order_consumes_stock` considera vendido (el MISMO criterio
--      ya usado para descontar stock -- refresh_inventory_from_order, ver
--      20260918110000 -- así que "vendido" significa lo mismo en todo el
--      sistema). Cubre tanto la transición de una orden existente como un
--      item agregado a una orden que YA está paga.
--   B. external_sales: al crear la fila (no hay estado "pendiente" en este
--      canal -- se carga ya como venta confirmada, ver sales-ledger/route.ts).
--   C. mercadolibre_sales: SIN CAMBIOS -- se mantiene el congelamiento
--      explícito al vincular/revincular en app/api/admin/mercadolibre-sales
--      (PATCH .../link, ver 20260918140000), que ya es el choke point
--      correcto: antes de vincular no hay producto contra el cual calcular
--      costo alguno.
--
-- Todas las funciones son idempotentes por diseño (sólo escriben si
-- costo_unitario_historico IS NULL, nunca sobrescriben un valor ya
-- congelado) y no dependen de nada del frontend. No se tocó ningún webhook
-- de pago ni RPC de checkout: el punto de enganche es el propio UPDATE de
-- `ordenes.estado/payment_status` (que YA ocurre server-side en cada
-- confirmación de pago, sea por webhook de Mercado Pago, verificación de
-- transferencia o confirmación manual de admin -- todos esos caminos ya
-- convergen en ese UPDATE, así que no hace falta tocar ninguno de ellos).

begin;

-- Reimplementación en SQL de getReceivedCostContribution/getHistoricalUnitCost
-- (lib/business/product-costs.ts): promedio ponderado de mercadería
-- REALMENTE recibida a una fecha dada, con el mismo fallback variante ->
-- producto que la lógica TS (una compra a nivel producto sólo cuenta si
-- variant_id es null en la fila de costo). Necesaria en SQL porque un
-- trigger no puede invocar código TypeScript -- es la única función de esta
-- fase con lógica duplicada respecto de la canónica, inevitable por el
-- lenguaje. `security definer`: sólo lee product_cost_entries y no depende
-- de qué GRANT de tabla tenga quien la invoque -- los triggers que la usan
-- ya son security definer (hereda ese contexto igual), pero declararla así
-- también la deja segura si alguna vez se llegara a invocar directamente.
create or replace function public.compute_historical_unit_cost(
  p_product_id bigint,
  p_variant_id bigint,
  p_as_of date
)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_quantity numeric := 0;
  v_cost numeric := 0;
begin
  if p_product_id is null then
    return null;
  end if;

  if p_variant_id is not null then
    select
      coalesce(sum(
        case
          when entries.reception_status in ('pendiente', 'anulada') then 0
          when entries.reception_status = 'recibida' then entries.quantity
          else least(greatest(coalesce(entries.received_quantity, 0), 0), entries.quantity)
        end
      ), 0),
      coalesce(sum(
        case
          when entries.reception_status in ('pendiente', 'anulada') then 0
          when entries.reception_status = 'recibida' then entries.total_cost
          else entries.total_cost
            * least(greatest(coalesce(entries.received_quantity, 0), 0), entries.quantity)
            / nullif(entries.quantity, 0)
        end
      ), 0)
    into v_quantity, v_cost
    from public.product_cost_entries entries
    where entries.variant_id = p_variant_id
      and entries.purchase_date <= p_as_of;

    if v_quantity > 0 then
      return round(v_cost / v_quantity, 2);
    end if;
  end if;

  select
    coalesce(sum(
      case
        when entries.reception_status in ('pendiente', 'anulada') then 0
        when entries.reception_status = 'recibida' then entries.quantity
        else least(greatest(coalesce(entries.received_quantity, 0), 0), entries.quantity)
      end
    ), 0),
    coalesce(sum(
      case
        when entries.reception_status in ('pendiente', 'anulada') then 0
        when entries.reception_status = 'recibida' then entries.total_cost
        else entries.total_cost
          * least(greatest(coalesce(entries.received_quantity, 0), 0), entries.quantity)
          / nullif(entries.quantity, 0)
      end
    ), 0)
  into v_quantity, v_cost
  from public.product_cost_entries entries
  where entries.product_id = p_product_id
    and entries.variant_id is null
    and entries.purchase_date <= p_as_of;

  if v_quantity > 0 then
    return round(v_cost / v_quantity, 2);
  end if;

  return null;
end;
$function$;

revoke all on function public.compute_historical_unit_cost(bigint, bigint, date)
  from public, anon, authenticated;
grant execute on function public.compute_historical_unit_cost(bigint, bigint, date)
  to service_role;

-- A. Web: congela cada orden_item de la orden que todavía no tenga snapshot,
-- en el instante en que la orden pasa a un estado "vendido". Idempotente por
-- el `where costo_unitario_historico is null`; no rompe nada si se dispara
-- de nuevo (doble click / reintento del webhook / cron de verificación).
create or replace function public.freeze_order_items_historical_cost()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not public.inventory_order_consumes_stock(new.estado, new.payment_status) then
    return new;
  end if;

  update public.orden_items items
  set costo_unitario_historico = public.compute_historical_unit_cost(
    items.producto_id,
    items.variante_id,
    coalesce(new.paid_at, new.created_at)::date
  )
  where items.orden_id = new.id
    and items.costo_unitario_historico is null;

  return new;
end;
$function$;

create or replace trigger freeze_order_items_historical_cost_after_order
  after update of estado, payment_status on public.ordenes
  for each row execute function public.freeze_order_items_historical_cost();

-- Cubre el caso de un item agregado (por un admin, o por cualquier flujo)
-- a una orden que YA está en estado "vendido" -- sin esto, ese item nunca
-- pasaría por el trigger de arriba (que sólo se dispara en UPDATE de
-- ordenes) y quedaría dependiendo del fallback dinámico para siempre.
create or replace function public.freeze_order_item_historical_cost_on_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_order public.ordenes%rowtype;
begin
  if new.costo_unitario_historico is not null then
    return new;
  end if;

  select * into v_order from public.ordenes where id = new.orden_id;

  if v_order.id is not null
     and public.inventory_order_consumes_stock(v_order.estado, v_order.payment_status) then
    new.costo_unitario_historico := public.compute_historical_unit_cost(
      new.producto_id,
      new.variante_id,
      coalesce(v_order.paid_at, v_order.created_at)::date
    );
  end if;

  return new;
end;
$function$;

create or replace trigger freeze_order_item_historical_cost_before_insert
  before insert on public.orden_items
  for each row execute function public.freeze_order_item_historical_cost_on_insert();

-- B. Ventas externas: no hay estado "pendiente" en este canal (se cargan ya
-- confirmadas, ver app/api/admin/sales-ledger/route.ts) -- el choke point es
-- la propia creación de la fila.
create or replace function public.freeze_external_sale_historical_cost()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.product_id is not null and new.costo_unitario_historico is null then
    new.costo_unitario_historico := public.compute_historical_unit_cost(
      new.product_id,
      new.variant_id,
      new.sale_date
    );
  end if;

  return new;
end;
$function$;

create or replace trigger freeze_external_sale_historical_cost_before_insert
  before insert on public.external_sales
  for each row execute function public.freeze_external_sale_historical_cost();

commit;
