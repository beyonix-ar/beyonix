-- Orden manual de productos destacados en Home.
--
-- productos.featured_position: posición 1, 2, 3… del destacado. NULL = destacado
-- sin posición (Home lo muestra después de los posicionados). Los destacados
-- existentes quedan en NULL: el Admin los ordena después.
--
-- Reglas en la base (no sólo en el frontend):
-- * la posición es > 0 y sólo existe si el producto está destacado;
-- * dos destacados nunca comparten posición (índice único parcial): de dos
--   Admins que asignan la misma posición a la vez, uno falla limpio;
-- * quitar el destacado limpia la posición en la misma escritura, venga de
--   donde venga (editor, archivado, fusión o la función de abajo).

alter table public.productos
  add column if not exists featured_position integer;

alter table public.productos
  drop constraint if exists productos_featured_position_positive;
alter table public.productos
  add constraint productos_featured_position_positive
  check (featured_position is null or featured_position > 0);

alter table public.productos
  drop constraint if exists productos_featured_position_requires_destacado;
alter table public.productos
  add constraint productos_featured_position_requires_destacado
  check (featured_position is null or destacado);

create unique index if not exists productos_featured_position_unique_idx
  on public.productos (featured_position)
  where destacado and featured_position is not null;

comment on column public.productos.featured_position is
  'Posición manual del producto destacado en Home (1 = primero). NULL = destacado sin posición, se muestra después. Única entre destacados; se limpia al quitar el destacado.';

create or replace function public.clear_unfeatured_product_position()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.destacado is distinct from true then
    new.featured_position := null;
  end if;
  return new;
end;
$$;

drop trigger if exists clear_unfeatured_product_position on public.productos;

create trigger clear_unfeatured_product_position
before insert or update of destacado, featured_position on public.productos
for each row execute function public.clear_unfeatured_product_position();

-- Destacar / cambiar posición / quitar destacado en UNA operación atómica.
-- Una posición ocupada se RECHAZA (nunca se intercambia ni se reordena en
-- silencio). `p_expected_revision` (opcional, la manda el editor) evita pisar
-- cambios de otra pestaña o usuario, igual que el guardado comercial.
create or replace function public.set_product_featured_position(
  p_product_id bigint,
  p_destacado boolean,
  p_position integer default null,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position integer := case when p_destacado then p_position else null end;
  v_revision bigint;
  v_occupant_name text;
  v_occupant_active boolean;
  v_result public.productos%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'No tenés permisos para cambiar los productos destacados.'
      using errcode = '42501';
  end if;
  if p_product_id is null or p_destacado is null then
    raise exception 'Los datos del destacado no son válidos.' using errcode = '22023';
  end if;
  if not p_destacado and p_position is not null then
    raise exception 'Un producto sin destacar no puede tener posición.' using errcode = '22023';
  end if;
  if v_position is not null and v_position <= 0 then
    raise exception 'La posición debe ser un número entero mayor que cero.' using errcode = '22023';
  end if;

  -- Mismo bloqueo por producto que el guardado comercial del editor.
  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select products.catalog_revision
  into v_revision
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.' using errcode = 'P0002';
  end if;
  if p_expected_revision is not null and v_revision <> p_expected_revision then
    raise exception 'El producto cambió desde que abriste el editor (otra pestaña, otro usuario o un evento comercial). Recargalo antes de guardar para no pisar esos cambios.'
      using errcode = '40001';
  end if;

  if v_position is not null then
    select products.nombre, products.activo
    into v_occupant_name, v_occupant_active
    from public.productos products
    where products.destacado
      and products.featured_position = v_position
      and products.id <> p_product_id
    limit 1;
    if found then
      raise exception 'La posición % ya está ocupada por "%"%. Quitale el destacado o cambiale la posición antes de asignarla.',
        v_position,
        v_occupant_name,
        case when v_occupant_active then '' else ' (inactivo)' end
        using errcode = '23505';
    end if;
  end if;

  begin
    update public.productos
    set destacado = p_destacado,
        featured_position = v_position
    where id = p_product_id
    returning * into v_result;
  exception when unique_violation then
    -- Otro Admin tomó la misma posición en paralelo: la base decide.
    raise exception 'La posición % acaba de ocuparse por otro producto destacado. Elegí otra posición.', v_position
      using errcode = '23505';
  end;

  return jsonb_build_object(
    'id', v_result.id,
    'destacado', v_result.destacado,
    'featured_position', v_result.featured_position,
    'catalog_revision', v_result.catalog_revision
  );
end;
$$;

revoke all on function public.set_product_featured_position(bigint, boolean, integer, bigint)
  from public, anon, authenticated;

grant execute on function public.set_product_featured_position(bigint, boolean, integer, bigint)
  to service_role;
