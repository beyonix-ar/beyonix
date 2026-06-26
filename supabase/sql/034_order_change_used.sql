alter table public.ordenes
  add column if not exists order_change_used boolean not null default false,
  add column if not exists order_change_status text,
  add column if not exists order_change_extra_amount numeric(12, 2);

alter table public.ordenes
  drop constraint if exists ordenes_order_change_status_check,
  add constraint ordenes_order_change_status_check check (
    order_change_status is null
    or order_change_status in ('change_requested', 'change_approved', 'extra_payment_pending', 'rejected')
  );

alter table public.order_claims
  add column if not exists replacement_original_product text,
  add column if not exists replacement_original_order_item_id bigint,
  add column if not exists replacement_original_variant text,
  add column if not exists replacement_original_price numeric(12, 2),
  add column if not exists replacement_requested_product_id bigint,
  add column if not exists replacement_requested_product text,
  add column if not exists replacement_requested_variant_id bigint,
  add column if not exists replacement_requested_variant text,
  add column if not exists replacement_requested_quantity integer,
  add column if not exists replacement_requested_stock integer,
  add column if not exists replacement_requested_price numeric(12, 2),
  add column if not exists replacement_price_difference numeric(12, 2),
  add column if not exists replacement_change_reason text,
  add column if not exists replacement_customer_selected_at timestamptz,
  add column if not exists replacement_product text,
  add column if not exists replacement_extra_cost numeric(12, 2),
  add column if not exists replacement_payment_link text,
  add column if not exists replacement_shipping_company text,
  add column if not exists replacement_tracking text,
  add column if not exists replacement_sent_at timestamptz,
  add column if not exists coupon_code text,
  add column if not exists coupon_created_at timestamptz;

alter table public.order_claims
  drop constraint if exists order_claims_status_check,
  add constraint order_claims_status_check check (
    status in (
      'recibido',
      'en_revision',
      'falta_informacion',
      'aprobado',
      'reintegro_pendiente',
      'cambio_pendiente',
      'cupon_pendiente',
      'reemplazo_enviado',
      'rechazado',
      'cerrado'
    )
  );

drop index if exists order_claims_one_active_per_order_idx;

create unique index if not exists order_claims_one_active_per_order_idx
  on public.order_claims(order_id)
  where status in (
    'recibido',
    'en_revision',
    'falta_informacion',
    'aprobado',
    'reintegro_pendiente',
    'cambio_pendiente',
    'cupon_pendiente',
    'reemplazo_enviado'
  );

create or replace function public.approve_order_claim_product_change(
  p_claim_id bigint,
  p_admin_id uuid
)
returns public.order_claims
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.order_claims%rowtype;
  v_order public.ordenes%rowtype;
  v_item public.orden_items%rowtype;
  v_product public.productos%rowtype;
  v_variant public.producto_variantes%rowtype;
  v_requested_product_id bigint;
  v_requested_variant_id bigint;
  v_quantity integer;
  v_new_unit_price numeric(12, 2);
  v_old_total numeric(12, 2);
  v_new_total numeric(12, 2);
  v_difference numeric(12, 2);
  v_available_stock integer;
begin
  select *
  into v_claim
  from public.order_claims
  where id = p_claim_id
  for update;

  if not found then
    raise exception 'No encontramos el reclamo.';
  end if;

  if v_claim.status <> 'cambio_pendiente' then
    raise exception 'El reclamo no está pendiente de cambio.';
  end if;

  if v_claim.replacement_product is not null then
    raise exception 'Este cambio ya fue aprobado.';
  end if;

  v_requested_product_id := v_claim.replacement_requested_product_id;
  v_requested_variant_id := v_claim.replacement_requested_variant_id;
  v_quantity := greatest(coalesce(v_claim.replacement_requested_quantity, 1), 1);

  if v_requested_product_id is null then
    raise exception 'El cliente todavía no eligió producto de reemplazo.';
  end if;

  select *
  into v_order
  from public.ordenes
  where id = v_claim.order_id
  for update;

  if not found then
    raise exception 'No encontramos el pedido.';
  end if;

  if v_order.invoice_status = 'authorized' or v_order.invoice_cae is not null then
    raise exception 'No se puede modificar un pedido facturado.';
  end if;

  if coalesce(v_order.estado, '') in ('enviado', 'en_camino', 'entregado', 'shipped', 'in_transit', 'delivered')
    or v_order.tracking_number is not null
    or v_order.andreani_tracking is not null
    or v_order.andreani_envio_id is not null then
    raise exception 'No se puede modificar un pedido despachado.';
  end if;

  select *
  into v_item
  from public.orden_items
  where orden_id = v_order.id
    and (
      v_claim.replacement_original_order_item_id is null
      or id = v_claim.replacement_original_order_item_id
    )
  order by id
  limit 1
  for update;

  if not found then
    raise exception 'No encontramos el producto original del pedido.';
  end if;

  select *
  into v_product
  from public.productos
  where id = v_requested_product_id
    and activo = true
  for update;

  if not found then
    raise exception 'El producto solicitado no está disponible.';
  end if;

  if v_requested_variant_id is not null then
    select *
    into v_variant
    from public.producto_variantes
    where id = v_requested_variant_id
      and producto_id = v_requested_product_id
      and activo = true
    for update;

    if not found then
      raise exception 'La variante solicitada no está disponible.';
    end if;

    v_available_stock := coalesce(v_variant.stock, 0);
  else
    v_available_stock := coalesce(v_product.stock, 0);
  end if;

  if v_available_stock < v_quantity then
    raise exception 'No hay stock suficiente para aprobar el cambio.';
  end if;

  v_new_unit_price := coalesce(v_product.precio, 0);
  v_old_total := coalesce(v_item.precio, 0) * coalesce(v_item.cantidad, 1);
  v_new_total := v_new_unit_price * v_quantity;
  v_difference := v_new_total - v_old_total;

  update public.orden_items
  set
    producto_id = v_requested_product_id,
    variante_id = v_requested_variant_id,
    cantidad = v_quantity,
    precio = v_new_unit_price
  where id = v_item.id;

  update public.ordenes
  set
    total = greatest(coalesce(total, 0) + v_difference, 0),
    order_change_status = case
      when v_difference > 0 then 'extra_payment_pending'
      else 'change_approved'
    end,
    order_change_extra_amount = greatest(v_difference, 0)
  where id = v_order.id;

  update public.order_claims
  set
    replacement_product = concat_ws(' · ', v_claim.replacement_requested_product, v_claim.replacement_requested_variant),
    replacement_extra_cost = greatest(v_difference, 0),
    replacement_requested_price = v_new_total,
    replacement_price_difference = v_difference,
    admin_needs_action = false,
    updated_at = now()
  where id = v_claim.id
  returning *
  into v_claim;

  insert into public.audit_logs (
    table_name,
    action,
    record_id,
    actor_user_id,
    before_data,
    after_data
  )
  values (
    'orden_items',
    'UPDATE',
    v_item.id::text,
    p_admin_id,
    jsonb_build_object(
      'order_id', v_order.id,
      'producto_anterior', v_item.producto_id,
      'variante_anterior', v_item.variante_id,
      'precio_anterior', v_item.precio,
      'cantidad_anterior', v_item.cantidad
    ),
    jsonb_build_object(
      'order_id', v_order.id,
      'claim_id', v_claim.id,
      'producto_nuevo', v_requested_product_id,
      'variante_nueva', v_requested_variant_id,
      'precio_nuevo', v_new_unit_price,
      'cantidad_nueva', v_quantity,
      'diferencia', v_difference,
      'motivo', v_claim.replacement_change_reason,
      'fecha', now()
    )
  );

  return v_claim;
end;
$$;

revoke all on function public.approve_order_claim_product_change(bigint, uuid) from public;
grant execute on function public.approve_order_claim_product_change(bigint, uuid) to authenticated;

alter table public.order_claim_files
  drop constraint if exists order_claim_files_file_role_check,
  add constraint order_claim_files_file_role_check check (
    file_role in (
      'embalaje_exterior',
      'producto_completo',
      'danio',
      'funcionamiento_foto',
      'video',
      'evidencia_inicial',
      'evidencia_adicional',
      'comprobante_devolucion'
    )
  );
