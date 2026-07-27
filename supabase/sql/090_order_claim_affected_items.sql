alter table public.order_claims
  add column if not exists affected_items jsonb not null default '[]'::jsonb,
  add column if not exists affected_items_updated_at timestamptz,
  add column if not exists affected_items_updated_by uuid references auth.users(id) on delete set null;

alter table public.order_claims
  drop constraint if exists order_claims_affected_items_is_array;

alter table public.order_claims
  add constraint order_claims_affected_items_is_array
  check (jsonb_typeof(affected_items) = 'array');

-- Recupera la selección de reclamos históricos desde la descripción que ya se
-- guardaba. Si decía "Todo el pedido", incorpora todas las líneas; en caso
-- contrario, busca únicamente los productos mencionados.
update public.order_claims as claim
set affected_items = coalesce(
  (
    select jsonb_agg(
      jsonb_build_object(
        'order_item_id', item.id,
        'quantity', item.cantidad
      )
      order by item.id
    )
    from public.orden_items as item
    left join public.productos as product on product.id = item.producto_id
    left join public.producto_variantes as variant on variant.id = item.variante_id
    where item.orden_id = claim.order_id
      and (
        lower(split_part(claim.description, E'\n', 1)) like 'producto afectado: todo el pedido recibido%'
        or (
          product.nombre is not null
          and position(
            lower(product.nombre)
            in lower(split_part(claim.description, E'\n', 1))
          ) > 0
          and (
            variant.nombre is null
            or position(
              lower(variant.nombre)
              in lower(split_part(claim.description, E'\n', 1))
            ) > 0
          )
        )
      )
  ),
  '[]'::jsonb
)
where claim.failure_type not in ('cancelar_compra', 'consulta_pedido')
  and claim.affected_items = '[]'::jsonb;

comment on column public.order_claims.affected_items is
  'Líneas y cantidades del pedido incluidas en el reclamo: [{order_item_id, quantity}].';
