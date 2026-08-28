-- P0: create_producto_completo() y update_product_catalog_atomic() seguían
-- referenciando por nombre las columnas cuotas_sin_interes/cuotas_maximas/
-- promo_original_cuotas_sin_interes/promo_original_cuotas_maximas que
-- 20260827100001_installments_financing_cleanup.sql eliminó. Como ninguna
-- migración había vuelto a tocar estas dos funciones desde antes de esa
-- limpieza, quedaron literalmente rotas (SQLSTATE 42703) desde el momento
-- en que se aplicó esa migración: CREAR o EDITAR cualquier producto en
-- Admin > Productos falla ahora mismo en producción, con el código viejo
-- YA desplegado en Netlify y también con el código nuevo (ambos llaman a
-- estas mismas funciones).
--
-- Este archivo reemplaza únicamente las líneas relacionadas con cuotas en
-- ambas funciones (todo lo demás queda copiado tal cual estaba), y agrega
-- compatibilidad hacia atrás: si el payload todavía manda las claves viejas
-- (cliente_nombre... digo, cuotas_sin_interes/cuotas_maximas -- el código
-- viejo aún desplegado en Netlify las sigue mandando hasta que se despliegue
-- el código nuevo), se interpretan con el mismo mapeo 1:1 sin ambigüedad
-- que ya usó el backfill de la migración original. Si el payload manda las
-- claves nuevas (cuotas_2/3/6_habilitadas), esas tienen prioridad.

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
  v_legacy_cuotas_sin_interes boolean := coalesce((p_producto ->> 'cuotas_sin_interes')::boolean, false);
  v_legacy_cuotas_maximas text := p_producto ->> 'cuotas_maximas';
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
    video_url,
    precio,
    precio_anterior,
    descuento,
    cuotas_2_habilitadas,
    cuotas_3_habilitadas,
    cuotas_6_habilitadas,
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
    nullif(trim(coalesce(p_producto ->> 'video_url', '')), ''),
    (p_producto ->> 'precio')::numeric,
    nullif(p_producto ->> 'precio_anterior', '')::numeric,
    nullif(p_producto ->> 'descuento', '')::integer,
    coalesce((p_producto ->> 'cuotas_2_habilitadas')::boolean, false),
    coalesce(
      (p_producto ->> 'cuotas_3_habilitadas')::boolean,
      v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '3'
    ),
    coalesce(
      (p_producto ->> 'cuotas_6_habilitadas')::boolean,
      v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '6'
    ),
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

create or replace function public.update_product_catalog_atomic(
  p_product_id bigint,
  p_catalog jsonb,
  p_primary_sku text,
  p_actor_id uuid
)
returns public.productos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product public.productos%rowtype;
  v_primary_variant_id bigint;
  v_name text := nullif(btrim(coalesce(p_catalog ->> 'nombre', '')), '');
  v_slug text := nullif(btrim(coalesce(p_catalog ->> 'slug', '')), '');
  v_price numeric := nullif(p_catalog ->> 'precio', '')::numeric;
  v_active boolean := coalesce((p_catalog ->> 'activo')::boolean, false);
  v_category_id bigint := nullif(p_catalog ->> 'categoria_id', '')::bigint;
  v_legacy_cuotas_sin_interes boolean := coalesce((p_catalog ->> 'cuotas_sin_interes')::boolean, false);
  v_legacy_cuotas_maximas text := p_catalog ->> 'cuotas_maximas';
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar el catálogo.';
  end if;
  if p_product_id is null
     or jsonb_typeof(coalesce(p_catalog, 'null'::jsonb)) <> 'object'
     or v_slug is null then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and v_name is null then
    raise exception 'Falta completar el título.';
  end if;
  if v_name is null then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and coalesce(v_price, 0) <= 0 then
    raise exception 'El precio debe ser mayor a $0.';
  end if;
  if v_price is null or v_price < 0 then
    raise exception 'Los datos comerciales del producto no son válidos.';
  end if;
  if v_active and (
    v_category_id is null
    or not exists (
      select 1 from public.categorias categories
      where categories.id = v_category_id
    )
  ) then
    raise exception 'Seleccioná una categoría.';
  end if;
  if v_active and (
    coalesce(nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric, 0) <= 0
    or coalesce(nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric, 0) <= 0
  ) then
    raise exception 'Completá peso, profundidad, ancho y largo.';
  end if;
  perform pg_advisory_xact_lock(93000, p_product_id::integer);
  select * into v_product
  from public.productos products
  where products.id = p_product_id
  for update;
  if not found then
    raise exception 'El producto ya no existe.';
  end if;

  select variants.id
  into v_primary_variant_id
  from public.producto_variantes variants
  where variants.producto_id = p_product_id
  order by variants.orden, variants.id
  limit 1
  for update;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);

  if v_primary_variant_id is not null then
    update public.producto_variantes
    set sku = nullif(left(btrim(coalesce(p_primary_sku, '')), 120), '')
    where id = v_primary_variant_id;
  end if;

  update public.productos products
  set nombre = left(v_name, 240),
      sku = case
        when v_primary_variant_id is null
          then nullif(left(btrim(coalesce(p_primary_sku, '')), 120), '')
        else null
      end,
      slug = left(v_slug, 240),
      descripcion = nullif(p_catalog ->> 'descripcion', ''),
      video_url = nullif(p_catalog ->> 'video_url', ''),
      precio = v_price,
      precio_anterior = nullif(p_catalog ->> 'precio_anterior', '')::numeric,
      descuento = nullif(p_catalog ->> 'descuento', '')::numeric,
      cuotas_2_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_2_habilitadas')::boolean,
        false
      ),
      cuotas_3_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_3_habilitadas')::boolean,
        v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '3'
      ),
      cuotas_6_habilitadas = coalesce(
        (p_catalog ->> 'cuotas_6_habilitadas')::boolean,
        v_legacy_cuotas_sin_interes and v_legacy_cuotas_maximas = '6'
      ),
      promo_event_id = nullif(p_catalog ->> 'promo_event_id', '')::uuid,
      promo_original_precio = nullif(
        p_catalog ->> 'promo_original_precio',
        ''
      )::numeric,
      promo_original_precio_anterior = nullif(
        p_catalog ->> 'promo_original_precio_anterior',
        ''
      )::numeric,
      promo_original_descuento = nullif(
        p_catalog ->> 'promo_original_descuento',
        ''
      )::numeric,
      promo_original_cuotas_2_habilitadas = nullif(
        p_catalog ->> 'promo_original_cuotas_2_habilitadas',
        ''
      )::boolean,
      promo_original_cuotas_3_habilitadas = nullif(
        p_catalog ->> 'promo_original_cuotas_3_habilitadas',
        ''
      )::boolean,
      promo_original_cuotas_6_habilitadas = nullif(
        p_catalog ->> 'promo_original_cuotas_6_habilitadas',
        ''
      )::boolean,
      categoria_id = v_category_id,
      destacado = coalesce((p_catalog ->> 'destacado')::boolean, false),
      activo = v_active,
      peso_empaquetado_kg = nullif(p_catalog ->> 'peso_empaquetado_kg', '')::numeric,
      alto_paquete_cm = nullif(p_catalog ->> 'alto_paquete_cm', '')::numeric,
      ancho_paquete_cm = nullif(p_catalog ->> 'ancho_paquete_cm', '')::numeric,
      largo_paquete_cm = nullif(p_catalog ->> 'largo_paquete_cm', '')::numeric
  where products.id = p_product_id
  returning * into v_product;

  if v_active then
    perform public.assert_product_can_activate(p_product_id);
  end if;

  return v_product;
end;
$$;

-- Limpieza del helper de diagnóstico temporal (sólo se usó para confirmar,
-- de forma read-only, el cuerpo real de estas dos funciones en producción).
drop function if exists public.__debug_get_functiondef(text);
