import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import {
  applyAvailableStock,
  type ActiveReservationTotal,
} from "./sellable-stock.ts"
import type { SupabaseProducto } from "../supabase/types.ts"

// Fase 5: stock vendible visible. Ejercita contra PostgreSQL (PGlite) la RPC
// nueva active_stock_reservation_totals junto con las piezas REALES del
// modelo: stock derivado (refresh_inventory_stock + triggers de órdenes),
// reserva del Paso 3 (reserve_cart_stock, 20 minutos) y liberación de la
// reserva al pagar/cancelar (release_order_stock_reservation). La última
// unidad con dos conexiones simultáneas se prueba con PostgreSQL embebido en
// lib/cart/checkout-step-reservations.test.mjs.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const legacyReservations = read("supabase/migrations/20260801095000_stock_reservations.sql")
const releaseFunction = legacyReservations.match(
  /create or replace function public\.release_order_stock_reservation\(\)[\s\S]*?\n\$\$;/,
)?.[0]
assert.ok(releaseFunction, "release_order_stock_reservation real")

async function setup() {
  const db = new PGlite()
  await db.exec(read("lib/inventory/fixtures/inventory-hardening-schema.sql"))
  await db.exec(read("supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql"))
  await db.exec(read("supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql"))
  await db.exec(read("supabase/migrations/20260918120000_stock_nonnegative_check_constraint.sql"))
  await db.exec(read("lib/inventory/fixtures/inventory-hardening-views.sql"))
  await db.exec(read("lib/inventory/fixtures/inventory-hardening-functions.sql"))
  await db.exec(`
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function public.complete_cart_stock_reservation(text, bigint) returns void language sql as $$ select $$;
    create function public.validate_checkout_inventory_reservation(jsonb, text, bigint) returns jsonb language sql as $$ select '{}'::jsonb $$;
  `)
  await db.exec(read("supabase/migrations/20260925120000_checkout_step_stock_reservations.sql"))
  await db.exec(read("supabase/migrations/20260926110000_retire_legacy_30_minute_checkout_reservation.sql"))
  await db.exec(releaseFunction!)
  await db.exec(`
    create trigger release_order_stock_reservation
    after update of estado, payment_status or delete on public.ordenes
    for each row execute function public.release_order_stock_reservation();
  `)
  await db.exec(read("supabase/migrations/20260926130000_active_stock_reservation_totals.sql"))
  await db.exec(read("supabase/migrations/20260926140000_active_stock_reservation_foreign_totals.sql"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

async function createProduct(db: PGlite, physical: number, variants: number[] = []) {
  const productId = (await db.query<{ id: number }>("insert into productos default values returning id")).rows[0].id
  const variantIds: number[] = []
  for (const quantity of variants) {
    const variantId = (await db.query<{ id: number }>(
      "insert into producto_variantes (producto_id) values ($1) returning id", [productId],
    )).rows[0].id
    variantIds.push(variantId)
    await db.query(
      "insert into product_cost_entries (product_id, variant_id, received_quantity) values ($1,$2,$3)",
      [productId, variantId, quantity],
    )
  }
  if (!variants.length && physical > 0) {
    await db.query(
      "insert into product_cost_entries (product_id, received_quantity) values ($1,$2)",
      [productId, physical],
    )
  }
  await db.query("select refresh_inventory_stock($1)", [productId])
  return { id: Number(productId), variants: variantIds.map(Number) }
}

type Item = { productId: number; quantity: number; variantId?: number | null }
const reserve = (db: PGlite, session: string, items: Item[]) =>
  db.query("select reserve_cart_stock($1, $2::jsonb) as result", [session, JSON.stringify(items)])

async function totals(db: PGlite, productIds: number[], excludeSession: string | null = null) {
  const { rows } = await db.query<ActiveReservationTotal>(
    "select * from active_stock_reservation_totals($1::bigint[], $2)",
    [productIds, excludeSession],
  )
  return rows.map((row) => ({
    product_id: Number(row.product_id),
    variant_id: row.variant_id == null ? null : Number(row.variant_id),
    conditioned_stock_id: row.conditioned_stock_id,
    reserved_quantity: Number(row.reserved_quantity),
  }))
}

/** Lo que ve el cliente: filas reales + RPC + la misma función TS del catálogo. */
async function storefront(db: PGlite, productId: number, excludeSession: string | null = null) {
  const product = (await db.query<{ id: number; stock: number; activo: boolean }>(
    "select id, stock, activo from productos where id=$1", [productId],
  )).rows[0]
  const variants = (await db.query<{ id: number; producto_id: number; stock: number; activo: boolean }>(
    "select id, producto_id, stock, activo from producto_variantes where producto_id=$1 order by id", [productId],
  )).rows
  const raw = {
    id: Number(product.id),
    stock: Number(product.stock),
    activo: product.activo,
    producto_variantes: variants.map((variant) => ({
      ...variant, id: Number(variant.id), stock: Number(variant.stock), orden: Number(variant.id),
    })),
  } as unknown as SupabaseProducto
  const [result] = applyAvailableStock([raw], await totals(db, [productId], excludeSession))
  return result
}

const physicalStock = async (db: PGlite, productId: number) =>
  Number((await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])).rows[0].stock)

const expireSession = (db: PGlite, session: string) => db.exec(`
  update checkout_reservation_sessions set reservation_started_at = now() - interval '21 minutes', expires_at = now() - interval '1 minute' where session_id = '${session}';
  update stock_reservations set expires_at = now() - interval '1 minute' where session_id = '${session}';
`)

test("A-B. físico 1: A reserva -> B ve 0 y no puede reservar; vence A -> B vuelve a ver 1", async () => {
  const db = await setup()
  try {
    const p = await createProduct(db, 1)
    await reserve(db, "fase5-a-session-0001", [{ productId: p.id, quantity: 1 }])

    const seenByB = await storefront(db, p.id)
    assert.equal(seenByB.stock, 0, "B ve disponible 0")
    assert.equal(seenByB.physical_stock, 1)
    assert.equal(seenByB.reserved_stock, 1)
    await assert.rejects(reserve(db, "fase5-b-session-0001", [{ productId: p.id, quantity: 1 }]), /OUT_OF_STOCK/)

    // La propia sesión no se descuenta a sí misma (carrito/checkout de A).
    assert.equal((await storefront(db, p.id, "fase5-a-session-0001")).stock, 1)

    await expireSession(db, "fase5-a-session-0001")
    assert.deepEqual(await totals(db, [p.id]), [], "la reserva vencida deja de contar")
    assert.equal((await storefront(db, p.id)).stock, 1, "B vuelve a tener disponible 1")
    assert.equal(await physicalStock(db, p.id), 1, "el físico nunca se tocó")
    await reserve(db, "fase5-b-session-0001", [{ productId: p.id, quantity: 1 }])
  } finally {
    await db.close()
  }
})

test("C. físico 3: A reserva 2 -> B sólo puede reservar 1 (no oversell)", async () => {
  const db = await setup()
  try {
    const p = await createProduct(db, 3)
    await reserve(db, "fase5-a-session-0002", [{ productId: p.id, quantity: 2 }])
    assert.equal((await storefront(db, p.id)).stock, 1)
    await assert.rejects(reserve(db, "fase5-b-session-0002", [{ productId: p.id, quantity: 2 }]), /OUT_OF_STOCK/)
    await reserve(db, "fase5-b-session-0002", [{ productId: p.id, quantity: 1 }])
    const seen = await storefront(db, p.id)
    assert.equal(seen.stock, 0)
    assert.equal(seen.reserved_stock, 3)
    await assert.rejects(reserve(db, "fase5-c-session-0002", [{ productId: p.id, quantity: 1 }]), /OUT_OF_STOCK/)
    assert.equal(await physicalStock(db, p.id), 3)
  } finally {
    await db.close()
  }
})

async function commitToOrder(db: PGlite, session: string, productId: number, quantity: number, variantId: number | null = null) {
  const orderId = Number((await db.query<{ id: number }>(
    "insert into ordenes (estado, payment_status) values ('pendiente', 'pending') returning id",
  )).rows[0].id)
  await db.query(
    "insert into orden_items (orden_id, producto_id, variante_id, cantidad) values ($1,$2,$3,$4)",
    [orderId, productId, variantId, quantity],
  )
  await db.query("update stock_reservations set order_id=$1 where session_id=$2", [orderId, session])
  return orderId
}

test("E. pedido pagado consume el físico una sola vez y cierra la reserva", async () => {
  const db = await setup()
  try {
    const p = await createProduct(db, 5)
    await reserve(db, "fase5-a-session-0003", [{ productId: p.id, quantity: 2 }])
    const orderId = await commitToOrder(db, "fase5-a-session-0003", p.id, 2)
    let seen = await storefront(db, p.id)
    assert.equal(seen.physical_stock, 5, "pendiente de pago: la reserva no es una venta")
    assert.equal(seen.reserved_stock, 2)
    assert.equal(seen.stock, 3)

    await db.query("update ordenes set estado='pagado', payment_status='approved' where id=$1", [orderId])
    seen = await storefront(db, p.id)
    assert.equal(seen.physical_stock, 3, "la venta descontó 2 del físico")
    assert.equal(seen.reserved_stock, 0, "la reserva se cerró al pagar")
    assert.equal(seen.stock, 3, "no resta dos veces (físico 3 - reservado 0)")

    // Webhook repetido / reintento: mismo resultado.
    await db.query("update ordenes set estado='pagado', payment_status='approved' where id=$1", [orderId])
    assert.equal((await storefront(db, p.id)).stock, 3)
    assert.equal(await physicalStock(db, p.id), 3)
  } finally {
    await db.close()
  }
})

test("E'. pago de Mercado Pago en proceso (reserva retenida sin vencimiento) sigue contando como reservado", async () => {
  const db = await setup()
  try {
    const p = await createProduct(db, 2)
    await reserve(db, "fase5-a-session-0004", [{ productId: p.id, quantity: 1 }])
    await commitToOrder(db, "fase5-a-session-0004", p.id, 1)
    await db.query("update stock_reservations set expires_at='infinity' where session_id=$1", ["fase5-a-session-0004"])
    const seen = await storefront(db, p.id)
    assert.equal(seen.reserved_stock, 1)
    assert.equal(seen.stock, 1)
  } finally {
    await db.close()
  }
})

test("F. cancelado/rechazado: sin stock negativo ni reservas fantasma", async () => {
  const db = await setup()
  try {
    const p = await createProduct(db, 2)
    await reserve(db, "fase5-a-session-0005", [{ productId: p.id, quantity: 2 }])
    const pending = await commitToOrder(db, "fase5-a-session-0005", p.id, 2)
    assert.equal((await storefront(db, p.id)).stock, 0)

    await db.query("update ordenes set estado='cancelado', payment_status='rejected' where id=$1", [pending])
    let seen = await storefront(db, p.id)
    assert.equal(seen.reserved_stock, 0, "la cancelación borra la reserva vinculada")
    assert.equal(seen.physical_stock, 2, "nunca se consumió: el físico queda igual")
    assert.equal(seen.stock, 2)
    assert.equal(
      Number((await db.query<{ n: number }>("select count(*)::int as n from stock_reservations where product_id=$1", [p.id])).rows[0].n),
      0,
    )

    // Pagado y después cancelado: vuelve exactamente una vez, nunca negativo.
    await reserve(db, "fase5-b-session-0005", [{ productId: p.id, quantity: 1 }])
    const paid = await commitToOrder(db, "fase5-b-session-0005", p.id, 1)
    await db.query("update ordenes set estado='pagado', payment_status='approved' where id=$1", [paid])
    assert.equal(await physicalStock(db, p.id), 1)
    await db.query("update ordenes set estado='cancelado' where id=$1", [paid])
    await db.query("update ordenes set estado='cancelado' where id=$1", [paid])
    seen = await storefront(db, p.id)
    assert.equal(seen.physical_stock, 2)
    assert.equal(seen.reserved_stock, 0)
    assert.equal(seen.stock, 2)

    // Una reserva que quedara por encima del físico nunca muestra negativo.
    await reserve(db, "fase5-c-session-0005", [{ productId: p.id, quantity: 2 }])
    await db.query("select set_config('beyonix.inventory_refresh','on',false)")
    await db.query("update productos set stock=1 where id=$1", [p.id])
    await db.query("select set_config('beyonix.inventory_refresh','',false)")
    assert.equal((await storefront(db, p.id)).stock, 0)
  } finally {
    await db.close()
  }
})

test("G. variantes: reservar Negra no afecta a Verde", async () => {
  const db = await setup()
  try {
    const p = await createProduct(db, 0, [2, 3])
    const [negra, verde] = p.variants
    await reserve(db, "fase5-a-session-0006", [{ productId: p.id, variantId: negra, quantity: 2 }])

    const seen = await storefront(db, p.id)
    const byId = new Map(seen.producto_variantes!.map((variant) => [variant.id, variant]))
    assert.equal(byId.get(negra)!.stock, 0)
    assert.equal(byId.get(verde)!.stock, 3, "Verde no se toca")
    assert.equal(seen.physical_stock, 5)
    assert.equal(seen.stock, 3, "el total del producto descuenta la reserva de Negra")

    await assert.rejects(
      reserve(db, "fase5-b-session-0006", [{ productId: p.id, variantId: negra, quantity: 1 }]),
      /OUT_OF_STOCK/,
    )
    await reserve(db, "fase5-b-session-0006", [{ productId: p.id, variantId: verde, quantity: 3 }])
  } finally {
    await db.close()
  }
})

test("reserva ajena sólo con certeza: otra cuenta sí; propia en otra sesión, invitado o consulta anónima no", async () => {
  const db = await setup()
  const owner = "20000000-0000-4000-8000-000000000001"
  const other = "20000000-0000-4000-8000-000000000002"
  const asUser = (userId: string | null) =>
    db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""])
  try {
    await db.query("insert into auth.users(id) values ($1), ($2)", [owner, other])
    const p = await createProduct(db, 10)

    await asUser(other)
    await reserve(db, "fase5-foreign-other-01", [{ productId: p.id, quantity: 2 }])
    await asUser(owner)
    await reserve(db, "fase5-foreign-owner-tab-b", [{ productId: p.id, quantity: 1 }])
    await asUser(null)
    await reserve(db, "fase5-foreign-guest-01", [{ productId: p.id, quantity: 3 }])

    const foreignFor = async (viewer: string | null, excludeSession: string | null = null) => {
      await asUser(viewer)
      const { rows } = await db.query<{ reserved_quantity: number; foreign_reserved_quantity: number }>(
        "select reserved_quantity, foreign_reserved_quantity from active_stock_reservation_totals($1::bigint[], $2)",
        [[p.id], excludeSession],
      )
      return rows.map((row) => [Number(row.reserved_quantity), Number(row.foreign_reserved_quantity)])
    }

    // El dueño (otra pestaña con su propia sesión) sólo ve como ajenas las 2 de la otra cuenta.
    assert.deepEqual(await foreignFor(owner), [[6, 2]])
    // Excluyendo su sesión actual el conteo baja, lo ajeno no cambia.
    assert.deepEqual(await foreignFor(owner, "fase5-foreign-owner-tab-b"), [[5, 2]])
    // La otra cuenta ve como ajena la del dueño; la del invitado nunca es "ajena con certeza".
    assert.deepEqual(await foreignFor(other), [[6, 1]])
    // Sin sesión no hay certeza de nada.
    assert.deepEqual(await foreignFor(null), [[6, 0]])
  } finally {
    await asUser(null)
    await db.close()
  }
})

test("seguridad/performance: sólo agregados, ejecutable por anon, sin lectura directa de reservas", async () => {
  const db = await setup()
  try {
    const p = await createProduct(db, 4)
    const q = await createProduct(db, 4)
    await reserve(db, "fase5-a-session-0007", [{ productId: p.id, quantity: 1 }, { productId: q.id, quantity: 2 }])
    await reserve(db, "fase5-b-session-0007", [{ productId: p.id, quantity: 1 }])

    const rows = await totals(db, [p.id, q.id])
    assert.deepEqual(
      rows.sort((left, right) => left.product_id - right.product_id),
      [
        { product_id: p.id, variant_id: null, conditioned_stock_id: null, reserved_quantity: 2 },
        { product_id: q.id, variant_id: null, conditioned_stock_id: null, reserved_quantity: 2 },
      ],
      "una fila agregada por destino, para muchos productos en una sola consulta",
    )
    const columns = (await db.query<{ name: string }>(`
      select unnest(proargnames) as name from pg_proc where proname = 'active_stock_reservation_totals'
    `)).rows.map((row) => row.name)
    assert.ok(!columns.some((name) => /session_id$|user_id|order_id|expires_at/.test(name) && name !== "p_exclude_session_id"))

    const privileges = (await db.query<{ anon_rpc: boolean; anon_table: boolean; auth_table: boolean }>(`
      select has_function_privilege('anon', 'public.active_stock_reservation_totals(bigint[], text)', 'EXECUTE') as anon_rpc,
             has_table_privilege('anon', 'public.stock_reservations', 'SELECT') as anon_table,
             has_table_privilege('authenticated', 'public.stock_reservations', 'SELECT') as auth_table
    `)).rows[0]
    assert.equal(privileges.anon_rpc, true)
    assert.equal(privileges.anon_table, false)
    assert.equal(privileges.auth_table, false)

    assert.deepEqual(await totals(db, []), [])
    const tooMany = Array.from({ length: 1_001 }, (_, index) => index + 1)
    await assert.rejects(totals(db, tooMany), /TOO_MANY_PRODUCTS/)
  } finally {
    await db.close()
  }
})
