-- Editar compra -> corregir el código de barra operativo de la variante
-- (Admin > Compras, 25/10/2026). Un proveedor puede mandar el mismo código
-- para varios colores: al editar la compra se le asigna a la variante el suyo.
--
-- Una sola transacción: bloqueo por producto, la compra debe ser de esa
-- variante, cambio del código y registro en audit_logs con el usuario. El
-- trigger genérico de auditoría toma auth.uid(), que con la service role es
-- null: sin este registro explícito el cambio quedaba sin autor.
--
-- Políticas existentes que se reutilizan, sin cambios:
--   * Unicidad: catalog_barcode_registry + catalog_barcode_aliases
--     (sync_variant_catalog_barcode_registry / guard_catalog_barcode_registry_alias).
--   * Vacío: ensure_catalog_barcode (20261019100000) asigna un código BEYONIX.
--   * Formato: ASCII imprimible, máximo 64, prefijos reservados prohibidos.
-- Ni la compra, ni la cantidad, ni el costo, ni el stock se tocan.

begin;

create or replace function public.update_variant_barcode_from_purchase(
  p_product_id bigint,
  p_variant_id bigint,
  p_purchase_id uuid,
  p_barcode text,
  p_actor_id uuid
)
returns public.producto_variantes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant public.producto_variantes%rowtype;
  v_before text;
  v_barcode text := public.normalized_catalog_barcode(p_barcode);
  v_actor_email text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'No tenés permisos para actualizar el código de barra.';
  end if;
  if p_product_id is null or p_variant_id is null or p_purchase_id is null then
    raise exception 'La compra o la variante indicada no es válida.';
  end if;

  perform pg_advisory_xact_lock(93000, p_product_id::integer);

  if not exists (
    select 1
    from public.product_cost_entries entries
    where entries.id = p_purchase_id
      and entries.product_id = p_product_id
      and entries.variant_id = p_variant_id
  ) then
    raise exception 'La compra no corresponde a esa variante.';
  end if;

  select * into v_variant
  from public.producto_variantes variants
  where variants.id = p_variant_id
    and variants.producto_id = p_product_id
  for update;
  if not found then
    raise exception 'La variante ya no existe.';
  end if;

  v_before := public.normalized_catalog_barcode(v_variant.codigo_barra);
  -- Mismo código: nada que cambiar ni auditar.
  if v_barcode is not distinct from v_before then
    return v_variant;
  end if;

  perform set_config('beyonix.actor_id', p_actor_id::text, true);
  update public.producto_variantes
  set codigo_barra = v_barcode
  where id = p_variant_id
  returning * into v_variant;

  select profiles.email into v_actor_email
  from public.profiles
  where profiles.id = p_actor_id;

  insert into public.audit_logs (
    table_name, action, record_id, actor_user_id, actor_email, before_data, after_data
  ) values (
    'producto_variantes',
    'UPDATE',
    p_variant_id::text,
    p_actor_id,
    v_actor_email,
    jsonb_build_object('codigo_barra', v_before),
    jsonb_build_object(
      'codigo_barra', v_variant.codigo_barra,
      'reason', 'purchase_barcode_edit',
      'productId', p_product_id,
      'purchaseId', p_purchase_id
    )
  );

  return v_variant;
end;
$$;

revoke all on function public.update_variant_barcode_from_purchase(bigint, bigint, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.update_variant_barcode_from_purchase(bigint, bigint, uuid, text, uuid)
  to service_role;

comment on function public.update_variant_barcode_from_purchase(bigint, bigint, uuid, text, uuid) is
  'Editar compra: cambia el código de barra de la variante comprada y lo audita con el usuario. Vacío = código BEYONIX (ensure_catalog_barcode).';

commit;
