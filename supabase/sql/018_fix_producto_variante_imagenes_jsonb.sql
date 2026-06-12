create or replace function public.create_producto_completo(
  p_producto jsonb,
  p_imagenes jsonb default '[]'::jsonb,
  p_variantes jsonb default '[]'::jsonb,
  p_especificaciones jsonb default '[]'::jsonb
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_email text := coalesce(auth.jwt() ->> 'email', current_setting('request.jwt.claim.email', true));
  v_producto public.productos%rowtype;
  v_imagen jsonb;
  v_variante jsonb;
  v_especificacion jsonb;
  v_trigger record;
  v_disabled_trigger text;
  v_disabled_triggers text[] := array[]::text[];
begin
  if v_actor_user_id is null then
    raise exception 'Tenés que iniciar sesión para crear productos.';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = v_actor_user_id
      and rol in ('admin', 'super_admin')
  ) then
    raise exception 'Solo un administrador puede crear productos.';
  end if;

  p_imagenes := coalesce(p_imagenes, '[]'::jsonb);
  p_variantes := coalesce(p_variantes, '[]'::jsonb);
  p_especificaciones := coalesce(p_especificaciones, '[]'::jsonb);

  for v_trigger in
    select
      c.relname as table_name,
      t.tgname as trigger_name
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public'
      and c.relname = any(array[
        'productos',
        'imagenes_producto',
        'producto_variantes',
        'producto_especificaciones'
      ])
      and not t.tgisinternal
      and t.tgenabled <> 'D'
      and (
        p.proname ilike '%audit%'
        or p.prosrc ilike '%audit_logs%'
      )
  loop
    execute format(
      'alter table public.%I disable trigger %I',
      v_trigger.table_name,
      v_trigger.trigger_name
    );

    v_disabled_triggers :=
      array_append(
        v_disabled_triggers,
        v_trigger.table_name || ':' || v_trigger.trigger_name
      );
  end loop;

  insert into public.productos (
    nombre,
    slug,
    descripcion,
    precio,
    precio_anterior,
    descuento,
    cuotas_sin_interes,
    cuotas_maximas,
    stock,
    categoria_id,
    destacado,
    activo,
    imagen_principal
  )
  values (
    trim(p_producto ->> 'nombre'),
    trim(p_producto ->> 'slug'),
    nullif(trim(coalesce(p_producto ->> 'descripcion', '')), ''),
    (p_producto ->> 'precio')::numeric,
    nullif(p_producto ->> 'precio_anterior', '')::numeric,
    nullif(p_producto ->> 'descuento', '')::integer,
    coalesce((p_producto ->> 'cuotas_sin_interes')::boolean, false),
    nullif(p_producto ->> 'cuotas_maximas', '')::integer,
    coalesce((p_producto ->> 'stock')::integer, 0),
    nullif(p_producto ->> 'categoria_id', '')::integer,
    coalesce((p_producto ->> 'destacado')::boolean, false),
    coalesce((p_producto ->> 'activo')::boolean, false),
    nullif(trim(coalesce(p_producto ->> 'imagen_principal', '')), '')
  )
  returning *
  into v_producto;

  for v_imagen in
    select value
    from jsonb_array_elements(p_imagenes)
  loop
    if nullif(trim(coalesce(v_imagen ->> 'url', '')), '') is not null then
      insert into public.imagenes_producto (
        producto_id,
        url,
        orden
      )
      values (
        v_producto.id,
        trim(v_imagen ->> 'url'),
        coalesce((v_imagen ->> 'orden')::integer, 1)
      );
    end if;
  end loop;

  for v_variante in
    select value
    from jsonb_array_elements(p_variantes)
  loop
    insert into public.producto_variantes (
      producto_id,
      nombre,
      color_hex,
      stock,
      imagenes,
      activo,
      orden
    )
    values (
      v_producto.id,
      trim(v_variante ->> 'nombre'),
      trim(v_variante ->> 'color_hex'),
      coalesce((v_variante ->> 'stock')::integer, 0),
      coalesce(v_variante -> 'imagenes', '[]'::jsonb),
      coalesce((v_variante ->> 'activo')::boolean, true),
      coalesce((v_variante ->> 'orden')::integer, 1)
    );
  end loop;

  for v_especificacion in
    select value
    from jsonb_array_elements(p_especificaciones)
  loop
    if
      nullif(trim(coalesce(v_especificacion ->> 'icono', '')), '') is not null
      and nullif(trim(coalesce(v_especificacion ->> 'texto', '')), '') is not null
    then
      insert into public.producto_especificaciones (
        producto_id,
        icono,
        texto,
        orden,
        activo
      )
      values (
        v_producto.id,
        trim(v_especificacion ->> 'icono'),
        trim(v_especificacion ->> 'texto'),
        coalesce((v_especificacion ->> 'orden')::integer, 1),
        coalesce((v_especificacion ->> 'activo')::boolean, true)
      );
    end if;
  end loop;

  select *
  into v_producto
  from public.productos
  where id = v_producto.id;

  foreach v_disabled_trigger in array v_disabled_triggers
  loop
    execute format(
      'alter table public.%I enable trigger %I',
      split_part(v_disabled_trigger, ':', 1),
      split_part(v_disabled_trigger, ':', 2)
    );
  end loop;

  insert into public.audit_logs (
    table_name,
    action,
    record_id,
    actor_user_id,
    actor_email,
    before_data,
    after_data
  )
  values (
    'productos',
    'INSERT',
    v_producto.id::text,
    v_actor_user_id,
    v_actor_email,
    null,
    to_jsonb(v_producto) ||
      jsonb_build_object(
        'imagenes_cargadas', jsonb_array_length(p_imagenes),
        'variantes_cargadas', jsonb_array_length(p_variantes),
        'especificaciones_cargadas', jsonb_array_length(p_especificaciones)
      )
  );

  return v_producto;
exception
  when others then
    foreach v_disabled_trigger in array v_disabled_triggers
    loop
      execute format(
        'alter table public.%I enable trigger %I',
        split_part(v_disabled_trigger, ':', 1),
        split_part(v_disabled_trigger, ':', 2)
      );
    end loop;

    raise;
end;
$$;

revoke all on function public.create_producto_completo(jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.create_producto_completo(jsonb, jsonb, jsonb, jsonb) to authenticated;
