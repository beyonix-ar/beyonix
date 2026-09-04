-- Guardado atómico de precio público + método de precio.
--
-- Hasta ahora el PATCH de catálogo hacía DOS escrituras separadas: la RPC
-- atómica que fija `productos.precio` y, después, un upsert a
-- `product_pricing`. Si la segunda fallaba, el producto quedaba con un precio
-- calculado por margen objetivo y metadata en 'manual' (o al revés), y el
-- siguiente recálculo partía de una configuración que no era la real.
--
-- Esta función envuelve ambas escrituras en la misma transacción reutilizando
-- la RPC existente (no la duplica): si algo falla, no queda ninguna de las
-- dos. Es aditiva -- `update_product_commercial_configuration_atomic` sigue
-- existiendo intacta.

begin;

create or replace function public.update_product_commercial_configuration_with_pricing_atomic(
  p_product_id bigint,
  p_catalog jsonb,
  p_primary_sku text,
  p_variant_states jsonb,
  p_actor_id uuid,
  p_pricing_mode text,
  p_target_margin_percent numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_mode text := coalesce(nullif(btrim(p_pricing_mode), ''), 'manual');
  v_margin numeric := p_target_margin_percent;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar la configuración comercial.';
  end if;

  if v_mode not in ('manual', 'target_margin') then
    raise exception 'El método de precio no es válido.';
  end if;

  -- En manual el margen objetivo no aplica: se limpia en vez de conservar un
  -- porcentaje viejo que después parecería vigente.
  if v_mode = 'manual' then
    v_margin := null;
  elsif v_margin is null or v_margin < 0 or v_margin >= 100 then
    raise exception 'El margen objetivo no es válido.';
  end if;

  v_result := public.update_product_commercial_configuration_atomic(
    p_product_id,
    p_catalog,
    p_primary_sku,
    p_variant_states,
    p_actor_id
  );

  insert into public.product_pricing (
    product_id, pricing_mode, target_margin_percent, updated_at, updated_by
  ) values (
    p_product_id, v_mode, v_margin, now(), p_actor_id
  )
  on conflict (product_id) do update
  set pricing_mode = excluded.pricing_mode,
      target_margin_percent = excluded.target_margin_percent,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  return v_result;
end;
$$;

revoke all on function public.update_product_commercial_configuration_with_pricing_atomic(
  bigint, jsonb, text, jsonb, uuid, text, numeric
) from public, anon, authenticated;
grant execute on function public.update_product_commercial_configuration_with_pricing_atomic(
  bigint, jsonb, text, jsonb, uuid, text, numeric
) to service_role;

comment on function public.update_product_commercial_configuration_with_pricing_atomic(
  bigint, jsonb, text, jsonb, uuid, text, numeric
) is
  'Guarda catálogo/variantes y método de precio en una sola transacción: productos.precio y product_pricing no pueden quedar desincronizados.';

commit;
