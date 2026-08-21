-- Regla de negocio: un producto con variantes nunca se compra "a nivel
-- producto" (product_cost_entries.variant_id null). El frontend (Compras)
-- ya deshabilita esa opción en el selector, pero la regla debe valerse por
-- sí misma en el servidor (CLAUDE.md: toda regla de negocio importante se
-- valida server-side, nunca sólo en el cliente).
--
-- Sólo aplica a compras NUEVAS (v_id is null): editar una compra histórica
-- que ya se guardó sin variante (dato legado, de antes de esta regla) sigue
-- permitido, para no romper la edición de documentos existentes.

create or replace function public.save_product_purchase_atomic(
  p_purchase jsonb,
  p_actor_id uuid
)
returns public.product_cost_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := nullif(p_purchase->>'id', '')::uuid;
  v_product_id bigint := nullif(p_purchase->>'product_id', '')::bigint;
  v_variant_id bigint := nullif(p_purchase->>'variant_id', '')::bigint;
  v_quantity integer := nullif(p_purchase->>'quantity', '')::integer;
  v_received integer := nullif(p_purchase->>'received_quantity', '')::integer;
  v_status text := coalesce(
    nullif(p_purchase->>'reception_status', ''),
    'recibida'
  );
  v_previous public.product_cost_entries%rowtype;
  v_saved public.product_cost_entries%rowtype;
  v_lock_product_id bigint;
begin
  if p_purchase is null or jsonb_typeof(p_purchase) <> 'object' then
    raise exception 'Los datos de la compra no son válidos.';
  end if;
  if v_quantity is null or v_quantity <= 0 then
    raise exception 'La cantidad comprada debe ser mayor que cero.';
  end if;
  if v_status not in ('pendiente', 'parcial', 'recibida', 'anulada') then
    raise exception 'El estado de recepción no es válido.';
  end if;

  v_received := case
    when v_status in ('pendiente', 'anulada') then 0
    when v_status = 'recibida' then v_quantity
    else coalesce(v_received, 0)
  end;
  if v_received < 0 or v_received > v_quantity then
    raise exception 'La cantidad recibida no puede superar la compra.';
  end if;
  if v_status = 'parcial'
     and (v_received <= 0 or v_received >= v_quantity) then
    raise exception 'La recepción parcial debe ser mayor que cero y menor que la compra.';
  end if;

  if v_id is not null then
    select * into v_previous
    from public.product_cost_entries entries
    where entries.id = v_id
    for update;
    if not found then
      raise exception 'La compra que querés editar ya no existe.';
    end if;
  end if;

  for v_lock_product_id in
    select distinct ids.product_id
    from unnest(array[v_previous.product_id, v_product_id]) ids(product_id)
    where ids.product_id is not null
    order by ids.product_id
  loop
    perform pg_advisory_xact_lock(93000, v_lock_product_id::integer);
  end loop;

  if v_variant_id is not null and not exists (
    select 1
    from public.producto_variantes variants
    where variants.id = v_variant_id
      and variants.producto_id = v_product_id
  ) then
    raise exception 'La variante no pertenece al producto seleccionado.';
  end if;

  if v_id is null
     and v_variant_id is null
     and v_product_id is not null
     and exists (
       select 1
       from public.producto_variantes variants
       where variants.producto_id = v_product_id
     ) then
    raise exception
      'Este producto tiene variantes: elegí el color/SKU específico que compraste.';
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  if v_id is null then
    insert into public.product_cost_entries (
      product_id, variant_id, article_name, sku, purchase_date,
      quantity, received_quantity, reception_status, unit_cost,
      freight_cost, tax_cost, commission_cost, other_cost, supplier,
      document_type, document_number, payment_method, notes, created_by
    ) values (
      v_product_id,
      v_variant_id,
      nullif(left(btrim(coalesce(p_purchase->>'article_name', '')), 180), ''),
      nullif(left(btrim(coalesce(p_purchase->>'sku', '')), 120), ''),
      (p_purchase->>'purchase_date')::date,
      v_quantity,
      v_received,
      v_status,
      coalesce((p_purchase->>'unit_cost')::numeric, 0),
      coalesce((p_purchase->>'freight_cost')::numeric, 0),
      coalesce((p_purchase->>'tax_cost')::numeric, 0),
      coalesce((p_purchase->>'commission_cost')::numeric, 0),
      coalesce((p_purchase->>'other_cost')::numeric, 0),
      nullif(left(btrim(coalesce(p_purchase->>'supplier', '')), 180), ''),
      nullif(left(btrim(coalesce(p_purchase->>'document_type', '')), 80), ''),
      nullif(left(btrim(coalesce(p_purchase->>'document_number', '')), 120), ''),
      nullif(left(btrim(coalesce(p_purchase->>'payment_method', '')), 100), ''),
      nullif(left(btrim(coalesce(p_purchase->>'notes', '')), 1000), ''),
      p_actor_id
    ) returning * into v_saved;
  else
    update public.product_cost_entries entries
    set
      product_id = v_product_id,
      variant_id = v_variant_id,
      article_name = nullif(left(btrim(coalesce(p_purchase->>'article_name', '')), 180), ''),
      sku = nullif(left(btrim(coalesce(p_purchase->>'sku', '')), 120), ''),
      purchase_date = (p_purchase->>'purchase_date')::date,
      quantity = v_quantity,
      received_quantity = v_received,
      reception_status = v_status,
      unit_cost = coalesce((p_purchase->>'unit_cost')::numeric, 0),
      freight_cost = coalesce((p_purchase->>'freight_cost')::numeric, 0),
      tax_cost = coalesce((p_purchase->>'tax_cost')::numeric, 0),
      commission_cost = coalesce((p_purchase->>'commission_cost')::numeric, 0),
      other_cost = coalesce((p_purchase->>'other_cost')::numeric, 0),
      supplier = nullif(left(btrim(coalesce(p_purchase->>'supplier', '')), 180), ''),
      document_type = nullif(left(btrim(coalesce(p_purchase->>'document_type', '')), 80), ''),
      document_number = nullif(left(btrim(coalesce(p_purchase->>'document_number', '')), 120), ''),
      payment_method = nullif(left(btrim(coalesce(p_purchase->>'payment_method', '')), 100), ''),
      notes = nullif(left(btrim(coalesce(p_purchase->>'notes', '')), 1000), '')
    where entries.id = v_id
    returning * into v_saved;
  end if;

  if exists (
    select 1 from public.productos products
    where products.id in (v_previous.product_id, v_saved.product_id)
      and products.stock < 0
  ) or exists (
    select 1 from public.producto_variantes variants
    where variants.producto_id in (v_previous.product_id, v_saved.product_id)
      and variants.stock < 0
  ) then
    raise exception 'STOCK_INSUFICIENTE: el cambio dejaría stock negativo.';
  end if;

  return v_saved;
end;
$$;

revoke all on function public.save_product_purchase_atomic(jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.save_product_purchase_atomic(jsonb, uuid)
  to service_role;
