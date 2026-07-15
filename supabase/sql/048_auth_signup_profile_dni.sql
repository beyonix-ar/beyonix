create or replace function public.sync_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    insert into public.profiles (
      id,
      email,
      username,
      nombre,
      telefono,
      dni,
      calle,
      numero,
      piso,
      departamento,
      localidad,
      codigo_postal,
      provincia,
      referencias,
      rol
    )
    values (
      new.id,
      new.email,
      nullif(new.raw_user_meta_data ->> 'username', ''),
      coalesce(new.raw_user_meta_data ->> 'nombre', ''),
      nullif(new.raw_user_meta_data ->> 'telefono', ''),
      nullif(new.raw_user_meta_data ->> 'dni', ''),
      nullif(new.raw_user_meta_data ->> 'calle', ''),
      nullif(new.raw_user_meta_data ->> 'numero', ''),
      nullif(new.raw_user_meta_data ->> 'piso', ''),
      nullif(new.raw_user_meta_data ->> 'departamento', ''),
      nullif(new.raw_user_meta_data ->> 'localidad', ''),
      nullif(new.raw_user_meta_data ->> 'codigo_postal', ''),
      nullif(new.raw_user_meta_data ->> 'provincia', ''),
      nullif(new.raw_user_meta_data ->> 'referencias', ''),
      'cliente'
    )
    on conflict (id) do update
    set
      email = excluded.email,
      username = coalesce(excluded.username, profiles.username),
      nombre = coalesce(nullif(excluded.nombre, ''), profiles.nombre),
      telefono = coalesce(excluded.telefono, profiles.telefono),
      dni = coalesce(excluded.dni, profiles.dni),
      calle = coalesce(excluded.calle, profiles.calle),
      numero = coalesce(excluded.numero, profiles.numero),
      piso = coalesce(excluded.piso, profiles.piso),
      departamento = coalesce(excluded.departamento, profiles.departamento),
      localidad = coalesce(excluded.localidad, profiles.localidad),
      codigo_postal = coalesce(excluded.codigo_postal, profiles.codigo_postal),
      provincia = coalesce(excluded.provincia, profiles.provincia),
      referencias = coalesce(excluded.referencias, profiles.referencias),
      rol = coalesce(profiles.rol, 'cliente');
  exception
    when unique_violation then
      insert into public.profiles (
        id,
        email,
        nombre,
        dni,
        rol
      )
      values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data ->> 'nombre', ''),
        nullif(new.raw_user_meta_data ->> 'dni', ''),
        'cliente'
      )
      on conflict (id) do update
      set
        email = excluded.email,
        nombre = coalesce(nullif(excluded.nombre, ''), profiles.nombre),
        dni = coalesce(excluded.dni, profiles.dni),
        rol = coalesce(profiles.rol, 'cliente');
  end;

  return new;
exception
  when others then
    raise warning 'sync_auth_user_profile failed for user %: %', new.id, sqlerrm;
    return new;
end;
$$;

create or replace function public.sync_signup_profile(user_id_input uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    id,
    email,
    username,
    nombre,
    telefono,
    dni,
    calle,
    numero,
    piso,
    departamento,
    localidad,
    codigo_postal,
    provincia,
    referencias,
    rol
  )
  select
    users.id,
    users.email,
    nullif(users.raw_user_meta_data ->> 'username', ''),
    coalesce(users.raw_user_meta_data ->> 'nombre', ''),
    nullif(users.raw_user_meta_data ->> 'telefono', ''),
    nullif(users.raw_user_meta_data ->> 'dni', ''),
    nullif(users.raw_user_meta_data ->> 'calle', ''),
    nullif(users.raw_user_meta_data ->> 'numero', ''),
    nullif(users.raw_user_meta_data ->> 'piso', ''),
    nullif(users.raw_user_meta_data ->> 'departamento', ''),
    nullif(users.raw_user_meta_data ->> 'localidad', ''),
    nullif(users.raw_user_meta_data ->> 'codigo_postal', ''),
    nullif(users.raw_user_meta_data ->> 'provincia', ''),
    nullif(users.raw_user_meta_data ->> 'referencias', ''),
    'cliente'
  from auth.users
  where users.id = user_id_input
    and (
      auth.uid() = users.id
      or (
        auth.uid() is null
        and users.email_confirmed_at is null
        and users.created_at >= now() - interval '10 minutes'
      )
    )
  on conflict (id) do update
  set
    email = excluded.email,
    username = coalesce(excluded.username, profiles.username),
    nombre = coalesce(nullif(excluded.nombre, ''), profiles.nombre),
    telefono = coalesce(excluded.telefono, profiles.telefono),
    dni = coalesce(excluded.dni, profiles.dni),
    calle = coalesce(excluded.calle, profiles.calle),
    numero = coalesce(excluded.numero, profiles.numero),
    piso = coalesce(excluded.piso, profiles.piso),
    departamento = coalesce(excluded.departamento, profiles.departamento),
    localidad = coalesce(excluded.localidad, profiles.localidad),
    codigo_postal = coalesce(excluded.codigo_postal, profiles.codigo_postal),
    provincia = coalesce(excluded.provincia, profiles.provincia),
    referencias = coalesce(excluded.referencias, profiles.referencias),
    rol = coalesce(profiles.rol, 'cliente');
end;
$$;

revoke all on function public.sync_signup_profile(uuid) from public;
grant execute on function public.sync_signup_profile(uuid) to anon, authenticated;
