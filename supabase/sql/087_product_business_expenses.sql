alter table public.business_expenses
  add column if not exists expense_type text not null default 'money',
  add column if not exists product_id bigint references public.productos(id) on delete restrict,
  add column if not exists variant_id bigint references public.producto_variantes(id) on delete restrict,
  add column if not exists product_name text,
  add column if not exists product_sku text,
  add column if not exists quantity integer;

alter table public.business_expenses
  drop constraint if exists business_expenses_expense_type_check,
  add constraint business_expenses_expense_type_check
    check (expense_type in ('money', 'product')),
  drop constraint if exists business_expenses_product_fields_check,
  add constraint business_expenses_product_fields_check check (
    (
      expense_type = 'money'
      and product_id is null
      and variant_id is null
      and quantity is null
    )
    or
    (
      expense_type = 'product'
      and product_id is not null
      and product_name is not null
      and quantity is not null
      and quantity > 0
      and amount = 0
      and category in ('Donación/Regalo', 'Sorteo/Evento')
    )
  );

create index if not exists business_expenses_product_idx
  on public.business_expenses (product_id, variant_id, expense_date desc)
  where product_id is not null;

create or replace function public.create_product_business_expense(
  p_expense_date date,
  p_category text,
  p_recipient text,
  p_category_detail text,
  p_description text,
  p_product_id bigint,
  p_variant_id bigint,
  p_product_name text,
  p_product_sku text,
  p_quantity integer,
  p_notes text,
  p_created_by uuid
)
returns public.business_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense public.business_expenses;
  v_product_stock integer;
  v_variant_product_id bigint;
  v_variant_stock integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para registrar salidas de inventario.';
  end if;

  if p_category not in ('Donación/Regalo', 'Sorteo/Evento')
     or p_product_id is null
     or p_quantity is null
     or p_quantity <= 0
     or trim(coalesce(p_product_name, '')) = '' then
    raise exception 'PRODUCT_EXPENSE_INVALID';
  end if;

  select coalesce(productos.stock, 0)
  into v_product_stock
  from public.productos
  where productos.id = p_product_id
  for update;

  if not found or v_product_stock < p_quantity then
    raise exception 'PRODUCT_EXPENSE_STOCK_INSUFFICIENT';
  end if;

  if exists (
    select 1
    from public.producto_variantes
    where producto_variantes.producto_id = p_product_id
  ) and p_variant_id is null then
    raise exception 'PRODUCT_EXPENSE_VARIANT_REQUIRED';
  end if;

  if p_variant_id is not null then
    select
      producto_variantes.producto_id,
      coalesce(producto_variantes.stock, 0)
    into v_variant_product_id, v_variant_stock
    from public.producto_variantes
    where producto_variantes.id = p_variant_id
    for update;

    if not found or v_variant_product_id <> p_product_id then
      raise exception 'PRODUCT_EXPENSE_VARIANT_INVALID';
    end if;

    if v_variant_stock < p_quantity then
      raise exception 'PRODUCT_EXPENSE_STOCK_INSUFFICIENT';
    end if;
  end if;

  update public.productos
  set stock = stock - p_quantity
  where id = p_product_id;

  if p_variant_id is not null then
    update public.producto_variantes
    set stock = stock - p_quantity
    where id = p_variant_id;
  end if;

  insert into public.business_expenses (
    expense_date,
    category,
    category_detail,
    recipient,
    description,
    amount,
    recurrence,
    status,
    tax_deductible,
    notes,
    expense_type,
    product_id,
    variant_id,
    product_name,
    product_sku,
    quantity,
    created_by
  )
  values (
    p_expense_date,
    p_category,
    nullif(trim(p_category_detail), ''),
    nullif(trim(p_recipient), ''),
    nullif(trim(p_description), ''),
    0,
    'unico',
    'pagado',
    false,
    nullif(trim(p_notes), ''),
    'product',
    p_product_id,
    p_variant_id,
    trim(p_product_name),
    nullif(trim(p_product_sku), ''),
    p_quantity,
    p_created_by
  )
  returning * into v_expense;

  return v_expense;
end;
$$;

create or replace function public.delete_business_expense_with_inventory(
  p_expense_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense public.business_expenses;
  v_variant_product_id bigint;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para eliminar gastos.';
  end if;

  select *
  into v_expense
  from public.business_expenses
  where id = p_expense_id
  for update;

  if not found then
    return false;
  end if;

  if v_expense.expense_type = 'product' then
    perform 1
    from public.productos
    where id = v_expense.product_id
    for update;

    if not found then
      raise exception 'PRODUCT_EXPENSE_PRODUCT_MISSING';
    end if;

    if v_expense.variant_id is not null then
      select producto_id
      into v_variant_product_id
      from public.producto_variantes
      where id = v_expense.variant_id
      for update;

      if not found or v_variant_product_id <> v_expense.product_id then
        raise exception 'PRODUCT_EXPENSE_VARIANT_INVALID';
      end if;
    end if;

    update public.productos
    set stock = coalesce(stock, 0) + v_expense.quantity
    where id = v_expense.product_id;

    if v_expense.variant_id is not null then
      update public.producto_variantes
      set stock = coalesce(stock, 0) + v_expense.quantity
      where id = v_expense.variant_id;
    end if;
  end if;

  delete from public.business_expenses
  where id = p_expense_id;

  return true;
end;
$$;

revoke all on function public.create_product_business_expense(
  date, text, text, text, text, bigint, bigint, text, text, integer, text, uuid
) from public, anon, authenticated;
grant execute on function public.create_product_business_expense(
  date, text, text, text, text, bigint, bigint, text, text, integer, text, uuid
) to service_role;

revoke all on function public.delete_business_expense_with_inventory(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_business_expense_with_inventory(uuid)
  to service_role;

comment on function public.create_product_business_expense(
  date, text, text, text, text, bigint, bigint, text, text, integer, text, uuid
) is
  'Registra una donación, regalo o sorteo de productos y descuenta su stock de forma atómica.';

comment on function public.delete_business_expense_with_inventory(uuid) is
  'Elimina un gasto y reintegra el stock cuando el movimiento correspondía a productos.';
