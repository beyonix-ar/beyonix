-- Protege también las altas y ediciones manuales del libro de ventas.

create or replace function public.prepare_manual_mercadolibre_sale_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if nullif(btrim(coalesce(new.source_key, '')), '') is not null then
    return new;
  end if;

  if nullif(btrim(coalesce(new.operation_id, '')), '') is null
     and nullif(btrim(coalesce(new.order_id, '')), '') is null then
    new.operation_id := 'manual:' || new.id::text;
  end if;

  new.source_key := public.mercadolibre_sale_source_key(
    new.operation_id,
    new.order_id,
    new.product_name,
    new.sku,
    new.sale_date,
    new.raw_data
  );
  return new;
end;
$$;

drop trigger if exists prepare_manual_mercadolibre_sale_identity
  on public.mercadolibre_sales;
create trigger prepare_manual_mercadolibre_sale_identity
before insert on public.mercadolibre_sales
for each row execute function public.prepare_manual_mercadolibre_sale_identity();

create or replace function public.lock_inventory_sale_targets()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_product_id bigint;
begin
  for v_product_id in
    select distinct targets.product_id
    from unnest(array[
      case when tg_op <> 'INSERT' then old.product_id else null end,
      case when tg_op <> 'DELETE' then new.product_id else null end
    ]) targets(product_id)
    where targets.product_id is not null
    order by targets.product_id
  loop
    perform pg_advisory_xact_lock(93000, v_product_id::integer);
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.reject_negative_inventory_sale()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_product_ids bigint[] := array[
    case when tg_op <> 'INSERT' then old.product_id else null end,
    case when tg_op <> 'DELETE' then new.product_id else null end
  ];
begin
  if exists (
    select 1
    from public.productos products
    where products.id = any(v_product_ids)
      and products.stock < 0
  ) or exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = any(v_product_ids)
      and variants.stock < 0
  ) then
    raise exception 'STOCK_INSUFICIENTE: la venta supera el stock disponible.';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists lock_inventory_external_sale on public.external_sales;
create trigger lock_inventory_external_sale
before insert or update or delete on public.external_sales
for each row execute function public.lock_inventory_sale_targets();

drop trigger if exists lock_inventory_mercadolibre_sale
  on public.mercadolibre_sales;
create trigger lock_inventory_mercadolibre_sale
before insert or update or delete on public.mercadolibre_sales
for each row execute function public.lock_inventory_sale_targets();

-- El prefijo zz garantiza que el control ocurra después de los triggers
-- refresh_inventory_after_* que recalculan el stock derivado.
drop trigger if exists zz_reject_negative_external_sale
  on public.external_sales;
create trigger zz_reject_negative_external_sale
after insert or update or delete on public.external_sales
for each row execute function public.reject_negative_inventory_sale();

drop trigger if exists zz_reject_negative_mercadolibre_sale
  on public.mercadolibre_sales;
create trigger zz_reject_negative_mercadolibre_sale
after insert or update or delete on public.mercadolibre_sales
for each row execute function public.reject_negative_inventory_sale();

