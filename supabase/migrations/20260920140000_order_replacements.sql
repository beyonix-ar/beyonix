-- Auditoría 4/7 (devoluciones), Fase 3 punto 6.
--
-- Hoy "cambio de producto"/"reemplazo por garantía" no existe como flujo
-- formal: la acción específica de reemplazo está deshabilitada (410 Gone,
-- app/api/admin/order-claims/[claimId]/route.ts) y en la práctica se
-- coordina por chat sin ningún registro estructurado -- riesgo real de
-- perder trazabilidad entre el producto devuelto y el que sale como
-- reemplazo (P1 de la auditoría).
--
-- Flujo mínimo, real, sin depender de chat/manual: una tabla
-- (order_replacements) que liga el ítem original con el producto/variante
-- de reemplazo, más una RPC que reutiliza el motor de stock YA existente y
-- auditado -- adjust_variant_stock_idempotent (mismo mecanismo que usa
-- Productos > Inventario para ajustes manuales: lock, delta, log,
-- auditoría) -- en vez de inventar un camino de stock nuevo. No se crea una
-- orden de reemplazo completa (evita reimplementar/arriesgar toda la
-- máquina de estados de checkout/pagos/envío sólo para esto); el costo se
-- congela con la misma función canónica que ya usan las ventas
-- (compute_historical_unit_cost, de 20260919100000).
--
-- Alcance reconocido: requiere que el producto de reemplazo tenga al menos
-- una variante (adjust_variant_stock_idempotent es variant-only, no existe
-- hoy un equivalente a nivel producto puro). Documentado como limitación
-- conocida en el reporte, no un bug silencioso.

begin;

create table public.order_replacements (
  id bigint generated always as identity primary key,
  original_order_id bigint not null references public.ordenes(id) on delete restrict,
  original_order_item_id bigint not null references public.orden_items(id) on delete restrict,
  claim_id bigint references public.order_claims(id) on delete set null,
  replacement_product_id bigint not null references public.productos(id) on delete restrict,
  replacement_variant_id bigint not null references public.producto_variantes(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  reason text not null check (reason in ('mismo_producto', 'otra_variante', 'otro_producto', 'garantia')),
  condition_note text,
  notes text,
  unit_cost numeric(12, 2),
  idempotency_key text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.order_replacements
  add constraint order_replacements_idempotency_key_key unique (idempotency_key);

create index order_replacements_original_order_item_idx
  on public.order_replacements (original_order_item_id);
create index order_replacements_original_order_idx
  on public.order_replacements (original_order_id);

alter table public.order_replacements enable row level security;
drop policy if exists "Admins read order replacements" on public.order_replacements;
create policy "Admins read order replacements"
on public.order_replacements for select to authenticated
using (current_user_role() = any (array['admin', 'super_admin']));

revoke all on public.order_replacements from public, anon, authenticated;
grant select on public.order_replacements to authenticated;
grant select, insert on public.order_replacements to service_role;

create or replace function public.create_order_replacement(
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

  -- Trazabilidad real, no chat: salvo garantía sin devolución física, exige
  -- que el producto original ya haya sido recibido (sano o roto) por el
  -- motor canónico de devoluciones antes de poder generar el reemplazo.
  if p_reason <> 'garantia'
     and coalesce(v_original_item.return_restocked_quantity, 0)
         + coalesce(v_original_item.return_written_off_quantity, 0) < p_quantity then
    raise exception 'REPLACEMENT_REQUIRES_RECEIVED_ITEM';
  end if;

  select * into v_variant
  from public.producto_variantes
  where id = p_replacement_variant_id;
  if not found then
    raise exception 'La variante de reemplazo no existe.';
  end if;

  -- Mismo lock que toda operación de stock (refresh_inventory_stock,
  -- adjust_variant_stock_idempotent, etc.) -- reentrante dentro de esta
  -- misma transacción, así que leer el stock acá y pasarlo como objetivo
  -- absoluto más abajo es seguro: nadie más puede tocar el stock de este
  -- producto hasta que esta transacción termine.
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

revoke all on function public.create_order_replacement(
  bigint, bigint, bigint, integer, text, uuid, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.create_order_replacement(
  bigint, bigint, bigint, integer, text, uuid, text, text, text, bigint
) to service_role;

notify pgrst, 'reload schema';

commit;
