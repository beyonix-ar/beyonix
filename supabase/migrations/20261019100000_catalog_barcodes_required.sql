-- Cada artículo físico tiene un código imprimible persistido. Se reutilizan
-- el formato BX-XXX-NNNNNN, la secuencia y el registro único del catálogo.
-- Un producto con variantes no es otro artículo físico: imprimen las variantes.

create or replace function public.next_beyonix_catalog_barcode(p_name text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_prefix text := public.beyonix_barcode_prefix(p_name);
  v_number bigint;
  v_code text;
begin
  loop
    v_number := nextval('public.beyonix_variant_barcode_seq');
    v_code := 'BX-' || v_prefix || '-' ||
      case when v_number < 1000000 then lpad(v_number::text, 6, '0') else v_number::text end;
    -- El registro principal y los alias usan este mismo candado. Evita que
    -- una carga manual concurrente tome el código elegido por la secuencia.
    perform pg_advisory_xact_lock(93002, hashtext(v_code));
    if not exists (
      select 1 from public.catalog_barcode_registry where normalized_barcode = v_code
    ) and not exists (
      select 1 from public.catalog_barcode_aliases where normalized_barcode = v_code
    ) then
      return v_code;
    end if;
  end loop;
end;
$$;

revoke all on function public.next_beyonix_catalog_barcode(text) from public, anon, authenticated;

create or replace function public.ensure_catalog_barcode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_name text;
begin
  new.codigo_barra := public.normalized_catalog_barcode(new.codigo_barra);
  if new.codigo_barra is null then
    if tg_table_name = 'productos' then
      -- El padre con variantes es sólo el grupo comercial.
      if exists (select 1 from public.producto_variantes where producto_id = new.id) then
        return new;
      end if;
      v_name := new.nombre;
    else
      select nombre into v_name from public.productos where id = new.producto_id;
    end if;
    new.codigo_barra := public.next_beyonix_catalog_barcode(v_name);
  end if;
  if length(new.codigo_barra) > 64
     or new.codigo_barra !~ '^[!-~]([ -~]*[!-~])?$' then
    raise exception 'El código de barras debe ser ASCII imprimible (máximo 64 caracteres).';
  end if;
  return new;
end;
$$;

revoke all on function public.ensure_catalog_barcode() from public, anon, authenticated;

create trigger ensure_product_catalog_barcode
before insert or update of codigo_barra, nombre on public.productos
for each row execute function public.ensure_catalog_barcode();

create trigger ensure_variant_catalog_barcode
before insert or update of codigo_barra on public.producto_variantes
for each row execute function public.ensure_catalog_barcode();

-- La acción manual existente usa exactamente el mismo asignador automático.
create or replace function public.generate_beyonix_variant_barcode(
  p_product_id bigint, p_variant_id bigint, p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_variant public.producto_variantes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para generar códigos de barra.';
  end if;
  select * into v_variant from public.producto_variantes
  where id = p_variant_id and producto_id = p_product_id for update;
  if not found then raise exception 'La variante ya no existe.'; end if;
  if public.normalized_catalog_barcode(v_variant.codigo_barra) is not null then
    return v_variant;
  end if;
  perform set_config('beyonix.actor_id', coalesce(p_actor_id::text, ''), true);
  update public.producto_variantes
  set codigo_barra = null
  where id = p_variant_id
  returning * into v_variant;
  return v_variant;
end;
$$;

-- Al crear la primera variante, el código interno temporal del padre deja
-- de identificar un artículo físico. Los códigos reales de proveedor se
-- conservan; pueden ser códigos del grupo comercial.
create or replace function public.release_parent_internal_barcode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  update public.productos
  set codigo_barra = null
  where id = new.producto_id
    and codigo_barra ~ '^BX-[A-Z]{3}-[0-9]{6,}$';
  return new;
end;
$$;

revoke all on function public.release_parent_internal_barcode() from public, anon, authenticated;

create trigger release_parent_internal_barcode
after insert on public.producto_variantes
for each row execute function public.release_parent_internal_barcode();

-- Si se borra la última variante de un producto, vuelve a existir un
-- artículo físico sin variantes; el trigger del padre le asigna un código.
create or replace function public.restore_standalone_product_barcode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not exists (select 1 from public.producto_variantes where producto_id = old.producto_id) then
    update public.productos set codigo_barra = codigo_barra
    where id = old.producto_id and codigo_barra is null;
  end if;
  return old;
end;
$$;

revoke all on function public.restore_standalone_product_barcode() from public, anon, authenticated;

create trigger restore_standalone_product_barcode
after delete on public.producto_variantes
for each row execute function public.restore_standalone_product_barcode();

-- NOT VALID permite agregar la restricción antes del backfill; ya protege
-- todas las escrituras nuevas. La migración siguiente valida las filas viejas.
alter table public.producto_variantes
  add constraint producto_variantes_codigo_barra_required
  check (public.normalized_catalog_barcode(codigo_barra) is not null) not valid;

-- Backfill idempotente: sólo artículos físicos que aún carecen de código.
-- En la auditoría previa: variantes 8 (CZ01) y 9 (AUMN01).
update public.producto_variantes
set codigo_barra = null
where public.normalized_catalog_barcode(codigo_barra) is null;

update public.productos p
set codigo_barra = null
where public.normalized_catalog_barcode(p.codigo_barra) is null
  and not exists (select 1 from public.producto_variantes v where v.producto_id = p.id);
