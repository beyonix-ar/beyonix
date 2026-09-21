-- Auditoría 4/7 (devoluciones), Fase 1 punto 2.
--
-- P0 confirmado: review_mercadolibre_return permitía sobrescribir
-- indefinidamente la clasificación (sano/roto/con descuento) de una
-- devolución de Mercado Libre ya aprobada -- `insert ... on conflict
-- (source_key) do update` sin ningún chequeo de "ya revisado". Dos admins
-- reclasificando la misma venta: gana el último en escribir, sin aviso al
-- primero (lost update silencioso).
--
-- Modelo elegido: (B) versionado + corrección explícita, igual que
-- mutate_admin_order_claim (p_expected_updated_at). No inmutable a secas
-- porque reclasificar una devolución de ML (el admin se equivocó al
-- tipear, o el estado del producto cambió al revisarlo mejor) es una
-- operación legítima del negocio -- lo que no puede pasar es que ocurra
-- SIN que el admin haya visto el estado vigente y sin dejar rastro de que
-- fue una corrección.
--
-- p_expected_approved_at: el admin manda el approved_at que vio en su
-- pantalla (null si es la primera revisión). Si no coincide con el estado
-- real -- alguien más ya revisó/corrigió mientras tanto -- se rechaza con
-- ML_RETURN_CONFLICT (409), nunca se pisa en silencio.
-- p_correction_reason: obligatorio (mínimo 3 caracteres) sólo cuando ya
-- existía una revisión previa (es decir, esto es una corrección, no la
-- primera revisión) -- queda en review_notes y en audit_logs.before_data/
-- after_data (ya existía ese registro, se mantiene sin cambios).

begin;

drop function if exists public.review_mercadolibre_return(
  uuid, integer, integer, integer, integer, numeric, text, text, text, timestamptz, uuid
);

create or replace function public.review_mercadolibre_return(
  p_sale_id uuid,
  p_received_quantity integer,
  p_sellable_quantity integer,
  p_discounted_quantity integer,
  p_non_sellable_quantity integer,
  p_discount_percent numeric,
  p_discount_reason text,
  p_non_sellable_reason text,
  p_notes text,
  p_occurred_at timestamp with time zone,
  p_reviewed_by uuid,
  p_expected_approved_at timestamptz default null,
  p_correction_reason text default null
)
returns inventory_return_movements
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sale public.mercadolibre_sales%rowtype;
  v_review public.inventory_return_movements%rowtype;
  v_previous jsonb;
  v_previous_approved_at timestamptz;
  v_notes text;
begin
  if p_received_quantity < 0
     or p_sellable_quantity < 0
     or p_discounted_quantity < 0
     or p_non_sellable_quantity < 0 then
    raise exception 'Las cantidades de la devolución no pueden ser negativas.';
  end if;

  if p_sellable_quantity
       + p_discounted_quantity
       + p_non_sellable_quantity
       > p_received_quantity then
    raise exception 'La clasificación supera las unidades recibidas.';
  end if;

  if p_discounted_quantity > 0 and (
    p_discount_percent is null
    or p_discount_percent <= 0
    or p_discount_percent >= 100
    or length(btrim(coalesce(p_discount_reason, ''))) < 3
  ) then
    raise exception 'Indicá el porcentaje y el motivo del descuento.';
  end if;

  if p_non_sellable_quantity > 0
     and length(btrim(coalesce(p_non_sellable_reason, ''))) < 3 then
    raise exception 'Indicá por qué las unidades no son vendibles.';
  end if;

  perform pg_advisory_xact_lock(hashtext('beyonix_ml_return'), hashtext(p_sale_id::text));

  select *
  into v_sale
  from public.mercadolibre_sales sales
  where sales.id = p_sale_id
  for update;

  if not found then
    raise exception 'La venta de Mercado Libre ya no existe.';
  end if;
  if v_sale.product_id is null then
    raise exception 'Primero vinculá la venta con un producto.';
  end if;
  perform pg_advisory_xact_lock(93000, v_sale.product_id::integer);
  if p_received_quantity > v_sale.quantity then
    raise exception 'No podés recibir más unidades que las vendidas.';
  end if;

  select to_jsonb(movements), movements.approved_at
  into v_previous, v_previous_approved_at
  from public.inventory_return_movements movements
  where movements.mercadolibre_sale_id = p_sale_id
  for update;

  -- Control optimista: nunca pisar en silencio un estado que el admin no
  -- vio. Primera revisión: no debe existir nada todavía. Corrección: el
  -- approved_at que el admin mandó tiene que coincidir con el vigente.
  if v_previous is null then
    if p_expected_approved_at is not null then
      raise exception 'ML_RETURN_CONFLICT';
    end if;
  else
    if p_expected_approved_at is null
       or p_expected_approved_at is distinct from v_previous_approved_at then
      raise exception 'ML_RETURN_CONFLICT';
    end if;
    if length(btrim(coalesce(p_correction_reason, ''))) < 3 then
      raise exception 'ML_RETURN_CORRECTION_REASON_REQUIRED';
    end if;
  end if;

  v_notes := nullif(left(trim(coalesce(p_notes, '')), 1000), '');
  if v_previous is not null and p_correction_reason is not null then
    v_notes := left(
      'Corrección: ' || btrim(p_correction_reason)
        || case when v_notes is not null then E'\n' || v_notes else '' end,
      1000
    );
  end if;

  -- El trigger genérico inventory_return_movements_audit_log_trigger (ver
  -- 20260920100000) ya audita este INSERT/UPDATE con before/after reales
  -- -- evita el insert manual duplicado que tenía esta función antes (mismo
  -- tipo de bug que se corrigió para force_delete_purchase_super_admin en
  -- la Auditoría 3/7). set_config le da el actor correcto vía auth.uid().
  perform set_config('beyonix.actor_id', p_reviewed_by::text, true);

  insert into public.inventory_return_movements (
    source_key,
    order_id,
    order_item_id,
    mercadolibre_sale_id,
    product_id,
    variant_id,
    quantity,
    received_quantity,
    sellable_quantity,
    discounted_quantity,
    non_sellable_quantity,
    discount_percent,
    discount_reason,
    non_sellable_reason,
    review_notes,
    occurred_at,
    approved_by,
    approved_at
  ) values (
    'mercadolibre-sale:' || v_sale.id::text,
    null,
    null,
    v_sale.id,
    v_sale.product_id,
    public.inventory_ml_variant_id(v_sale.raw_data),
    p_sellable_quantity,
    p_received_quantity,
    p_sellable_quantity,
    p_discounted_quantity,
    p_non_sellable_quantity,
    case when p_discounted_quantity > 0 then p_discount_percent else null end,
    case
      when p_discounted_quantity > 0
      then nullif(left(btrim(p_discount_reason), 300), '')
      else null
    end,
    case
      when p_non_sellable_quantity > 0
      then nullif(left(btrim(p_non_sellable_reason), 300), '')
      else null
    end,
    v_notes,
    coalesce(p_occurred_at, now()),
    p_reviewed_by,
    now()
  )
  on conflict (source_key) do update set
    quantity = excluded.quantity,
    received_quantity = excluded.received_quantity,
    sellable_quantity = excluded.sellable_quantity,
    discounted_quantity = excluded.discounted_quantity,
    non_sellable_quantity = excluded.non_sellable_quantity,
    discount_percent = excluded.discount_percent,
    discount_reason = excluded.discount_reason,
    non_sellable_reason = excluded.non_sellable_reason,
    review_notes = excluded.review_notes,
    occurred_at = excluded.occurred_at,
    approved_by = excluded.approved_by,
    approved_at = excluded.approved_at
  returning * into v_review;

  if exists (
    select 1 from public.productos products
    where products.id = v_sale.product_id and products.stock < 0
  ) or exists (
    select 1 from public.producto_variantes variants
    where variants.producto_id = v_sale.product_id and variants.stock < 0
  ) then
    raise exception
      'STOCK_INSUFICIENTE: la reclasificación consumiría stock ya vendido.';
  end if;

  return v_review;
end;
$function$;

revoke all on function public.review_mercadolibre_return(
  uuid, integer, integer, integer, integer, numeric, text, text, text, timestamptz, uuid, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.review_mercadolibre_return(
  uuid, integer, integer, integer, integer, numeric, text, text, text, timestamptz, uuid, timestamptz, text
) to service_role;

notify pgrst, 'reload schema';

commit;
