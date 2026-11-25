import { readFileSync } from 'node:fs'

// Base de prueba para la clasificación de compras de prueba (PGlite y
// PostgreSQL real). Usa las migraciones y las funciones REALES de recepción
// de devoluciones; el seed reproduce BX-1019 / BX-1020 con los datos
// verificados en solo lectura (comprador, pago, total e ítems), que son los
// que exige la autorización de la migración.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function extractFunction(source, name) {
  const start = source.indexOf(`create or replace function public.${name}(`)
  if (start < 0) throw new Error(`No se encontró ${name}`)
  const ends = ['\n$$;\n', '\n$function$;\n']
    .map((marker) => { const index = source.indexOf(marker, start); return index < 0 ? Infinity : index + marker.length })
  return source.slice(start, Math.min(...ends))
}

const reception = read('../../../supabase/migrations/20260920110000_unify_return_reception_rpc.sql')

export const OWNER = '6ebd099d-2fd4-418b-b3b2-2ff212afad53'
export const ADMIN = '10000000-0000-4000-8000-000000000002'
export const CLIENT = '10000000-0000-4000-8000-000000000003'
export const SECOND_SUPER = '10000000-0000-4000-8000-000000000004'

export const SCHEMA = read('./test-order-classification-schema.sql')
export const RETURN_RECEPTION = [
  extractFunction(reception, 'prevent_return_inventory_reprocessing'),
  `create or replace trigger prevent_return_inventory_reprocessing
    before update on public.orden_items
    for each row execute function public.prevent_return_inventory_reprocessing();`,
  extractFunction(reception, 'record_order_item_return_reception'),
  extractFunction(reception, 'process_claim_return_inventory'),
].join('\n')
export const ARCHIVE = read('../../../supabase/migrations/20261015150000_order_test_archive.sql')
export const CLASSIFICATION = read('../../../supabase/migrations/20261124120000_test_order_classification.sql')

export const SEED = `
  insert into auth.users values ('${OWNER}'), ('${ADMIN}'), ('${CLIENT}'), ('${SECOND_SUPER}');
  insert into profiles values ('${OWNER}', 'super_admin'), ('${ADMIN}', 'admin'), ('${CLIENT}', 'cliente'), ('${SECOND_SUPER}', 'super_admin');
  insert into productos (id, nombre) values (22, 'AURICULAR ÑANDÚ'), (30, 'LÁMPARA ÁMBAR');
  insert into producto_variantes (id, producto_id, nombre) values (22, 22, 'Negro mate'), (30, 30, 'Única');
  insert into product_cost_entries (product_id, variant_id, received_quantity) values (22, 22, 8), (30, 30, 10);
  insert into ordenes (id, usuario_id, estado, payment_method_id, payment_status, financial_status, admin_visible_at,
    paid_at, payment_confirmed_at, payment_confirmed_amount, total, invoice_status, invoice_cae, payment_id) values
    (19, '${OWNER}', 'entregado', 'mercadopago', 'approved', 'payment_confirmed', now(), now(), now(), 20, 20, 'authorized', 'CAE-19', '188037020242'),
    (20, '${OWNER}', 'entregado', 'mercadopago', 'approved', 'payment_confirmed', now(), now(), now(), 100, 100, 'authorized', 'CAE-20', '190138021303'),
    (21, '${CLIENT}', 'entregado', 'mercadopago', 'approved', 'payment_confirmed', now(), now(), now(), 500, 500, 'authorized', 'CAE-21', 'MP-21'),
    (23, '${OWNER}', 'entregado', 'mercadopago', 'approved', 'payment_confirmed', now(), now(), now(), 50, 50, 'authorized', 'CAE-23', 'MP-23'),
    (24, '${OWNER}', 'pagado', 'mercadopago', 'approved', 'payment_confirmed', now(), now(), now(), 50, 50, 'authorized', 'CAE-24', 'MP-24'),
    (25, '${OWNER}', 'entregado', 'mercadopago', 'approved', 'payment_confirmed', now(), now(), now(), 50, 50, 'authorized', 'CAE-25', 'MP-25');
  insert into orden_items (id, orden_id, producto_id, variante_id, cantidad) values
    (26, 19, 22, 22, 1), (27, 20, 22, 22, 1), (28, 21, 30, 30, 1), (31, 23, 30, 30, 1), (32, 24, 30, 30, 1), (33, 25, 30, 30, 1);
  -- Reclamo #8 de BX-1019, ya cerrado (cancelado por el propietario).
  insert into order_claims (order_id, status, failure_type, affected_items)
    values (19, 'cerrado', 'otro', '[{"order_item_id": 26, "quantity": 1}]');
  -- BX-1023: la unidad ya volvió por una devolución recibida.
  insert into inventory_return_movements (source_key, order_id, order_item_id, product_id, variant_id, quantity, received_quantity, sellable_quantity)
    values ('order-item:31:seed', 23, 31, 30, 30, 1, 1, 1);
  select refresh_inventory_stock(22);
  select refresh_inventory_stock(30);
`

/** Sentencias en orden: esquema, seed, recepción real, archivo y clasificación. */
export const SETUP = [SCHEMA, SEED, RETURN_RECEPTION, ARCHIVE, CLASSIFICATION]

/**
 * Autoriza un pedido de prueba como lo haría una migración futura (único
 * camino): sólo para ejercitar ramas con pedidos que no son BX-1019/1020.
 */
export const authorizeForTest = (orderId) => `
  insert into test_order_authorizations (order_id, buyer_id, expected_total, expected_payment_id, expected_items, evidence)
  select o.id, o.usuario_id, o.total, o.payment_id,
    (select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'productId', i.producto_id, 'variantId', i.variante_id, 'quantity', i.cantidad) order by i.id)
     from orden_items i where i.orden_id = o.id),
    'Autorización de prueba del fixture (equivale a una migración).'
  from ordenes o where o.id = ${Number(orderId)};
`
