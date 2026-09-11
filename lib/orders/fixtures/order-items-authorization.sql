-- Fixture aislado de autorización: sin conexión remota ni datos reales.
-- Las tres policies de orden_items y las dos de lectura de ordenes provienen
-- del catálogo remoto del 2026-09-11. Las funciones de validación de INSERT
-- se copiaron con pg_get_functiondef; no se usa supabase/sql histórico.
-- Tablas mínimas: no reproduce todo el inventario, auditoría ni devoluciones.
-- Esos triggers se inspeccionaron remotamente: no recalculan el total cobrado.

create role anon;
create role authenticated;
create role service_role bypassrls;
create role unrelated_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
grant usage on schema public, auth to anon, authenticated, service_role, unrelated_role;

create table public.profiles (id uuid primary key, rol text);
create table public.ordenes (
  id bigint primary key, usuario_id uuid, estado text, payment_status text,
  total numeric not null, original_total numeric not null, external_amount_due numeric not null
);
create table public.productos (id bigint primary key, stock integer not null);
create table public.producto_variantes (
  id bigint primary key, producto_id bigint references public.productos(id), stock integer not null
);
create table public.orden_items (
  id bigint generated always as identity primary key,
  orden_id bigint references public.ordenes(id) on delete cascade,
  producto_id bigint references public.productos(id),
  variante_id bigint references public.producto_variantes(id),
  cantidad integer not null default 1, precio numeric not null,
  warranty_status text not null default 'pending_delivery'
);
alter table public.orden_items enable row level security;
alter table public.ordenes enable row level security;
grant all privileges on public.orden_items to anon, authenticated, service_role;
grant select on public.ordenes, public.profiles, public.productos, public.producto_variantes
  to anon, authenticated, service_role;
grant all privileges on public.ordenes to service_role;

create policy "Users can insert own order items" on public.orden_items for INSERT to authenticated
  with check ((EXISTS ( SELECT 1
   FROM ordenes o
  WHERE ((o.id = orden_items.orden_id) AND (o.usuario_id = auth.uid())))));

create policy "Users can read own order items" on public.orden_items for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM ordenes o
  WHERE ((o.id = orden_items.orden_id) AND (o.usuario_id = auth.uid())))));

create policy "orden_items_admin_all" on public.orden_items for ALL to public
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.rol = 'admin'::text)))));

create policy "Admins can read ordenes" on public.ordenes for SELECT to authenticated
  using ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.rol = ANY (ARRAY['admin'::text, 'super_admin'::text]))))));

create policy "ordenes_select_own" on public.ordenes for SELECT to public
  using ((auth.uid() = usuario_id));

CREATE OR REPLACE FUNCTION public.inventory_order_consumes_stock(p_status text, p_payment_status text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  select
    coalesce(p_status, '') in (
      'pagado',
      'preparado',
      'enviado',
      'en_camino',
      'visita_fallida',
      'en_sucursal',
      'retiro_pendiente',
      'retiro_vencido',
      'en_devolucion',
      'devuelto_beyonix',
      'entregado',
      'approved'
    )
    or (
      coalesce(p_status, '') <> 'cancelado'
      and coalesce(p_payment_status, '') in (
        'confirmado',
        'confirmed',
        'approved'
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.validate_inventory_order_item()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_order public.ordenes;
  v_available integer;
  v_previous_quantity integer := 0;
begin
  select *
  into v_order
  from public.ordenes
  where id = new.orden_id;

  if not found
     or not public.inventory_order_consumes_stock(
       v_order.estado,
       v_order.payment_status
     ) then
    return new;
  end if;

  perform pg_advisory_xact_lock(93000, new.producto_id::integer);

  if tg_op = 'UPDATE'
     and old.producto_id = new.producto_id
     and old.variante_id is not distinct from new.variante_id then
    v_previous_quantity := old.cantidad;
  end if;

  if new.variante_id is not null then
    select coalesce(variants.stock, 0)
    into v_available
    from public.producto_variantes variants
    where variants.id = new.variante_id
      and variants.producto_id = new.producto_id;
  else
    select coalesce(products.stock, 0)
    into v_available
    from public.productos products
    where products.id = new.producto_id;
  end if;

  if not found or v_available + v_previous_quantity < new.cantidad then
    raise exception 'CHECKOUT_STOCK_INSUFFICIENT';
  end if;

  return new;
end;
$function$;

CREATE TRIGGER validate_inventory_order_item BEFORE INSERT OR UPDATE OF producto_id, variante_id, cantidad ON public.orden_items FOR EACH ROW EXECUTE FUNCTION validate_inventory_order_item();

CREATE OR REPLACE FUNCTION public.validate_order_item_variant_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_variant_product_id bigint;
begin
  if new.variante_id is not null then
    select variants.producto_id
    into v_variant_product_id
    from public.producto_variantes variants
    where variants.id = new.variante_id;

    if not found or v_variant_product_id <> new.producto_id then
      raise exception 'La variante del pedido no pertenece al producto.';
    end if;
  elsif exists (
    select 1
    from public.producto_variantes variants
    where variants.producto_id = new.producto_id
  ) then
    raise exception 'CHECKOUT_VARIANT_REQUIRED';
  end if;

  return new;
end;
$function$;

CREATE TRIGGER validate_order_item_variant_identity BEFORE INSERT OR UPDATE OF producto_id, variante_id ON public.orden_items FOR EACH ROW EXECUTE FUNCTION validate_order_item_variant_identity();
