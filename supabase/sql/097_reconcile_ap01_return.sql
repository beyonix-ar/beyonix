-- Corrección puntual informada por administración:
-- la devolución ML 2000012958302463 recibió 2 AP01,
-- 1 volvió en buen estado y 1 queda pendiente de clasificación.
-- La inserción es idempotente y nunca pisa una revisión posterior hecha desde el panel.

insert into public.inventory_return_movements (
  source_key,
  order_id,
  order_item_id,
  mercadolibre_sale_id,
  product_id,
  variant_id,
  quantity,
  received_quantity,
  sellable_quantity,
  discounted_quantity,
  non_sellable_quantity,
  discount_percent,
  review_notes,
  approved_by,
  approved_at
)
select
  'mercadolibre-sale:' || sales.id::text,
  null,
  null,
  sales.id,
  sales.product_id,
  null,
  1,
  2,
  1,
  0,
  0,
  null,
  '1 unidad en buen estado. 1 unidad pendiente de definir: rebaja o no vendible.',
  null,
  now()
from public.mercadolibre_sales sales
where sales.operation_id = '2000012958302463'
  and sales.sku = 'AP01'
  and sales.quantity = 2
  and sales.product_id is not null
on conflict (source_key) do nothing;
