-- Devoluciones y eliminaciones de Mercado Libre atómicas, fechadas y auditadas.

alter table public.inventory_return_movements
  add column if not exists occurred_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.inventory_return_movements
set occurred_at = coalesce(approved_at, created_at)
where occurred_at is null;

alter table public.inventory_return_movements
  alter column occurred_at set default now(),
  alter column occurred_at set not null;

create or replace function public.touch_inventory_return_movement()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_inventory_return_movement
  on public.inventory_return_movements;
create trigger touch_inventory_return_movement
before update on public.inventory_return_movements
for each row execute function public.touch_inventory_return_movement();

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
  p_occurred_at timestamptz,
  p_reviewed_by uuid
)
returns public.inventory_return_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.mercadolibre_sales%rowtype;
  v_review public.inventory_return_movements%rowtype;
  v_previous jsonb;
  v_actor_email text;
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

  select to_jsonb(movements)
  into v_previous
  from public.inventory_return_movements movements
  where movements.mercadolibre_sale_id = p_sale_id
  for update;

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
    nullif(left(btrim(coalesce(p_notes, '')), 1000), ''),
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

  select coalesce(profiles.email, users.email::text)
  into v_actor_email
  from auth.users users
  left join public.profiles on profiles.id = users.id
  where users.id = p_reviewed_by;

  insert into public.audit_logs (
    table_name,
    action,
    record_id,
    actor_user_id,
    actor_email,
    before_data,
    after_data
  ) values (
    'inventory_return_movements',
    case when v_previous is null then 'INSERT' else 'UPDATE' end,
    v_review.id::text,
    p_reviewed_by,
    v_actor_email,
    v_previous,
    to_jsonb(v_review)
  );

  return v_review;
end;
$$;

revoke all on function public.review_mercadolibre_return(
  uuid, integer, integer, integer, integer, numeric,
  text, text, text, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.review_mercadolibre_return(
  uuid, integer, integer, integer, integer, numeric,
  text, text, text, timestamptz, uuid
) to service_role;

create or replace function public.delete_mercadolibre_sales_atomic(
  p_sale_id uuid,
  p_expected_count integer,
  p_deleted_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_deleted integer;
  v_review_count integer;
  v_effective_units bigint;
  v_actor_email text;
begin
  perform pg_advisory_xact_lock(hashtext('beyonix_mercadolibre_import'));

  select
    count(*)::integer,
    coalesce(sum(public.inventory_ml_stock_units(
      sales.quantity,
      sales.raw_data
    )), 0)::bigint
  into v_count, v_effective_units
  from public.mercadolibre_sales sales
  where p_sale_id is null or sales.id = p_sale_id;

  if p_expected_count is not null and p_expected_count <> v_count then
    raise exception
      'La cantidad de ventas cambió: se esperaban % y actualmente hay %. Recargá y confirmá nuevamente.',
      p_expected_count,
      v_count;
  end if;

  select count(*)::integer
  into v_review_count
  from public.inventory_return_movements movements
  where movements.mercadolibre_sale_id in (
    select sales.id
    from public.mercadolibre_sales sales
    where p_sale_id is null or sales.id = p_sale_id
  );

  delete from public.mercadolibre_sales sales
  where p_sale_id is null or sales.id = p_sale_id;
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    select coalesce(profiles.email, users.email::text)
    into v_actor_email
    from auth.users users
    left join public.profiles on profiles.id = users.id
    where users.id = p_deleted_by;

    insert into public.audit_logs (
      table_name,
      action,
      record_id,
      actor_user_id,
      actor_email,
      before_data,
      after_data
    ) values (
      'mercadolibre_sales',
      'DELETE',
      coalesce(p_sale_id::text, 'bulk:' || txid_current()::text),
      p_deleted_by,
      v_actor_email,
      jsonb_build_object(
        'deleted_count', v_deleted,
        'return_reviews_deleted', v_review_count,
        'effective_stock_units_reverted', v_effective_units,
        'scope', case when p_sale_id is null then 'all' else 'single' end
      ),
      null
    );
  end if;

  return jsonb_build_object(
    'deleted', v_deleted,
    'returnReviewsDeleted', v_review_count,
    'effectiveStockUnitsReverted', v_effective_units
  );
end;
$$;

revoke all on function public.delete_mercadolibre_sales_atomic(
  uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function public.delete_mercadolibre_sales_atomic(
  uuid, integer, uuid
) to service_role;

comment on function public.delete_mercadolibre_sales_atomic(
  uuid, integer, uuid
) is
  'Elimina una venta ML o todas, revierte su libro derivado y audita en una única transacción.';
