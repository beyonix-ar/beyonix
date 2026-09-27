import assert from "node:assert/strict"
import test from "node:test"

import {
  applyAvailableStock,
  attachReservedStock,
  calculateAvailableStock,
  fetchActiveReservationTotals,
  summarizeProductReservations,
  type ActiveReservationTotal,
} from "./sellable-stock.ts"
import { describeStockReservation } from "./stock-reservation-details.ts"
import {
  CART_STOCK_ISSUES_MESSAGE,
  MAX_CART_ITEM_QUANTITY,
  PURCHASE_LIMIT_MESSAGE,
  STOCK_LIMIT_EXHAUSTED_MESSAGE,
  STOCK_LIMIT_RESERVED_MESSAGE,
  STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE,
  getQuantityLimitMessage,
  getCartStockIssueMessage,
  getCartStockIssues,
  getMaxPurchasableQuantity,
  getProductStock,
  hasPurchasableStock,
} from "../cart/stock-status.ts"
import { getProductVariantOptions } from "../products/product-variants.ts"
import type {
  SupabaseConditionedStock,
  SupabaseProducto,
  SupabaseProductoVariante,
} from "../supabase/types.ts"

function product(overrides: Partial<SupabaseProducto> = {}): SupabaseProducto {
  return {
    id: 1,
    nombre: "Trípode",
    precio: 10_000,
    precio_anterior: null,
    descuento: null,
    stock: 5,
    activo: true,
    imagenes_producto: [],
    producto_variantes: [],
    conditioned_stock: [],
    ...overrides,
  } as unknown as SupabaseProducto
}

function variant(id: number, stock: number, nombre: string): SupabaseProductoVariante {
  return {
    id,
    producto_id: 1,
    nombre,
    color_hex: "#000000",
    stock,
    activo: true,
    orden: id,
    imagenes: [],
  } as unknown as SupabaseProductoVariante
}

function conditioned(id: string, quantity: number): SupabaseConditionedStock {
  return {
    id,
    product_id: 1,
    variant_id: null,
    original_quantity: quantity,
    sold_quantity: 0,
    quantity,
    discount_percent: 20,
    reason: "Caja dañada",
    non_sellable_quantity: 0,
    non_sellable_reason: null,
    active: true,
    approved_at: "2026-09-01T00:00:00.000Z",
    conditioned_name: "Negro con descuento",
    conditioned_sku: "TRI-D",
    conditioned_color_hex: "#111111",
    conditioned_images: [],
  }
}

const total = (
  productId: number,
  reserved: number,
  variantId: number | null = null,
  conditionedStockId: string | null = null,
  foreign = 0,
): ActiveReservationTotal => ({
  product_id: productId,
  variant_id: variantId,
  conditioned_stock_id: conditionedStockId,
  reserved_quantity: reserved,
  foreign_reserved_quantity: foreign,
})

test("físico/reservado/disponible: 5 - 2 = 3 y nunca negativo", () => {
  assert.equal(calculateAvailableStock(5, 2), 3)
  assert.equal(calculateAvailableStock(10, 3), 7)
  assert.equal(calculateAvailableStock(1, 1), 0)
  assert.equal(calculateAvailableStock(1, 4), 0, "lo reservado nunca deja un disponible negativo")
  assert.equal(calculateAvailableStock(-2, 0), 0)
  assert.equal(calculateAvailableStock(Number.NaN, 1), 0)
})

test("catálogo: producto sin variantes físico 5, reservado 2 -> se puede comprar 3 como máximo", () => {
  const [result] = applyAvailableStock([product({ stock: 5 })], [total(1, 2)])
  assert.equal(result.stock, 3)
  assert.equal(result.physical_stock, 5)
  assert.equal(result.reserved_stock, 2)
  assert.equal(getProductStock(result), 3)
  assert.equal(getMaxPurchasableQuantity(result), 3)
})

test("catálogo: máximo 3 por producto aunque haya más disponible", () => {
  const [result] = applyAvailableStock([product({ stock: 10 })], [total(1, 1)])
  assert.equal(result.stock, 9)
  assert.equal(getMaxPurchasableQuantity(result), MAX_CART_ITEM_QUANTITY)
})

test("disponible 0 -> agotado: no se puede agregar, pero el producto sigue visible (físico > 0)", () => {
  const raw = product({ stock: 1 })
  assert.equal(hasPurchasableStock(raw), true, "la visibilidad se evalúa sobre el físico, antes de reservas")
  const [result] = applyAvailableStock([raw], [total(1, 1)])
  assert.equal(result.stock, 0)
  assert.equal(getMaxPurchasableQuantity(result), 0)
})

test("vencida la reserva, el disponible vuelve sin tocar el físico", () => {
  const raw = product({ stock: 1 })
  const reserved = applyAvailableStock([raw], [total(1, 1)])
  assert.equal(reserved[0].stock, 0)
  // La RPC ya no devuelve la reserva vencida (expires_at > now()).
  const expired = applyAvailableStock([raw], [])
  assert.equal(expired[0].stock, 1)
  assert.equal(expired[0].physical_stock, 1)
})

test("idempotente: aplicar dos veces parte del físico guardado, no resta dos veces", () => {
  const once = applyAvailableStock([product({ stock: 5 })], [total(1, 2)])
  const twice = applyAvailableStock(once, [total(1, 2)])
  assert.equal(twice[0].stock, 3)
  assert.equal(twice[0].physical_stock, 5)
})

test("variantes: reservar Negra no afecta a Verde; el total del producto sí la descuenta", () => {
  const raw = product({
    stock: 5,
    producto_variantes: [variant(11, 2, "Negra"), variant(12, 3, "Verde")],
  })
  const [result] = applyAvailableStock([raw], [total(1, 2, 11)])
  const negra = result.producto_variantes!.find((item) => item.id === 11)!
  const verde = result.producto_variantes!.find((item) => item.id === 12)!
  assert.equal(negra.stock, 0)
  assert.equal(negra.reserved_stock, 2)
  assert.equal(verde.stock, 3)
  assert.equal(verde.reserved_stock, 0)
  assert.equal(result.stock, 3, "productos.stock es el total: incluye lo asignado a cada variante")
  const options = getProductVariantOptions(result)
  assert.equal(options.find((option) => option.id === 11)?.stock, 0)
  assert.equal(options.find((option) => option.id === 12)?.stock, 3)
  assert.equal(getMaxPurchasableQuantity(result, "variant:12"), 3)
})

test("stock con descuento: pool aparte; totalmente reservado se muestra agotado sin desaparecer", () => {
  const raw = product({ stock: 4, conditioned_stock: [conditioned("c-1", 1)] })
  const [result] = applyAvailableStock([raw], [total(1, 1, null, "c-1")])
  assert.equal(result.stock, 4, "la reserva condicionada no toca el stock normal")
  assert.equal(result.conditioned_stock![0].quantity, 0)
  assert.equal(result.conditioned_stock![0].physical_quantity, 1)
  const option = getProductVariantOptions(result).find((item) => item.conditionedStockId === "c-1")
  assert.ok(option, "la variante con descuento sigue visible (si no, el carrito la quitaría en silencio)")
  assert.equal(option.stock, 0)
})

test("Admin: attachReservedStock conserva el físico y agrega lo reservado", () => {
  const raw = product({
    stock: 10,
    producto_variantes: [variant(11, 4, "Negra"), variant(12, 6, "Verde")],
    conditioned_stock: [conditioned("c-1", 2)],
  })
  const [result] = attachReservedStock([raw], [total(1, 3, 11), total(1, 1, null, "c-1")])
  assert.equal(result.stock, 10)
  assert.equal(result.reserved_stock, 3)
  assert.equal(calculateAvailableStock(result.stock, result.reserved_stock), 7)
  assert.equal(result.producto_variantes![0].stock, 4)
  assert.equal(result.producto_variantes![0].reserved_stock, 3)
  assert.equal(result.conditioned_stock![0].quantity, 2)
  assert.equal(result.conditioned_stock![0].reserved_quantity, 1)
})

test("summarizeProductReservations ignora otros productos y suma varias filas", () => {
  const summary = summarizeProductReservations(1, [
    total(1, 1, 11), total(1, 2, 11), total(2, 3), total(1, 1, null, "c-1"),
  ])
  assert.equal(summary.normal, 3)
  assert.equal(summary.byVariant.get(11), 3)
  assert.equal(summary.byConditioned.get("c-1"), 1)
})

test("listados: una consulta por lote (sin N+1), excluye la sesión propia y degrada si falta la migración", async () => {
  const calls: Array<{ name: string; args: { p_product_ids: number[]; p_exclude_session_id: string | null } }> = []
  const client = {
    rpc: async (name: string, args: { p_product_ids: number[]; p_exclude_session_id: string | null }) => {
      calls.push({ name, args })
      return {
        data: args.p_product_ids.includes(1)
          ? [{ product_id: "1", variant_id: null, conditioned_stock_id: null, reserved_quantity: "2" }]
          : [],
        error: null,
      }
    },
  }
  const ids = Array.from({ length: 1_200 }, (_, index) => index + 1)
  const totals = await fetchActiveReservationTotals(client as never, [...ids, 1, 0, -3], {
    excludeSessionId: "checkout-session-own",
  })
  assert.equal(calls.length, 3, "1.200 productos = 3 lotes de 500, no 1.200 consultas")
  assert.ok(calls.every((call) => call.name === "active_stock_reservation_totals"))
  assert.ok(calls.every((call) => call.args.p_exclude_session_id === "checkout-session-own"))
  assert.deepEqual(totals, [{
    product_id: 1, variant_id: null, conditioned_stock_id: null,
    reserved_quantity: 2,
    // La RPC anterior no trae la columna: sin certeza de reserva ajena.
    foreign_reserved_quantity: 0,
  }])

  const missing = { rpc: async () => ({ data: null, error: { message: "Could not find the function public.active_stock_reservation_totals" } }) }
  assert.deepEqual(await fetchActiveReservationTotals(missing as never, [1]), [])

  const failing = { rpc: async () => ({ data: null, error: { message: "permission denied" } }) }
  await assert.rejects(
    fetchActiveReservationTotals(failing as never, [1]),
    (error: { message: string }) => /permission denied/.test(error.message),
    "un error real no se oculta: el llamador decide",
  )
  assert.deepEqual(await fetchActiveReservationTotals(failing as never, []), [], "sin productos no consulta")
})

test("carrito: tenía 3 y quedan 2 -> se informa, no se borra y no deja avanzar", () => {
  const [fresh] = applyAvailableStock([product({ stock: 3 })], [total(1, 1)])
  const issues = getCartStockIssues([{ product: fresh, color: "default", quantity: 3 }])
  assert.deepEqual(issues, [{ productId: 1, color: "default", requested: 3, available: 2 }])
  assert.equal(getCartStockIssueMessage(issues[0]), "Sólo quedan 2 unidades disponibles. Reducí la cantidad para continuar.")
  assert.equal(getCartStockIssueMessage({ available: 1 }), "Sólo queda 1 unidad disponible. Reducí la cantidad para continuar.")
  assert.equal(getCartStockIssueMessage({ available: 0 }), "Sin stock disponible por ahora. Quitalo del carrito para continuar.")
  assert.match(CART_STOCK_ISSUES_MESSAGE, /Corregí las cantidades/)
  assert.deepEqual(getCartStockIssues([{ product: fresh, color: "default", quantity: 2 }]), [])
})

test("bloqueo del +: distingue reservas ajenas (A), stock agotado (B) y límite de 3", () => {
  // A) físico 3, otra cuenta reservó 1 (certeza de la base): con 2 no se suma.
  const [reservedByOthers] = applyAvailableStock([product({ stock: 3 })], [total(1, 1, null, null, 1)])
  assert.equal(getQuantityLimitMessage(reservedByOthers, "default", 2), STOCK_LIMIT_RESERVED_MESSAGE)
  assert.equal(getQuantityLimitMessage(reservedByOthers, "default", 1), null, "todavía se puede sumar")
  // Todo reservado por otra cuenta: tampoco se puede agregar la primera.
  const [allReserved] = applyAvailableStock([product({ stock: 1 })], [total(1, 1, null, null, 1)])
  assert.equal(getQuantityLimitMessage(allReserved, "default", 0), STOCK_LIMIT_RESERVED_MESSAGE)

  // B) físico 2 sin reservas: con 2 en el carrito ya no queda nada.
  const [exhausted] = applyAvailableStock([product({ stock: 2 })], [])
  assert.equal(getQuantityLimitMessage(exhausted, "default", 2), STOCK_LIMIT_EXHAUSTED_MESSAGE)
  // Sin datos de reservas (producto leído sin la RPC) nunca culpa a una reserva.
  assert.equal(getQuantityLimitMessage(product({ stock: 2 }), "default", 2), STOCK_LIMIT_EXHAUSTED_MESSAGE)

  // Límite de compra: hay stock de sobra.
  const [plenty] = applyAvailableStock([product({ stock: 10 })], [total(1, 2)])
  assert.equal(getQuantityLimitMessage(plenty, "default", 3), PURCHASE_LIMIT_MESSAGE)

  // Variantes: la reserva de Negra no explica el bloqueo de Verde.
  const [variants] = applyAvailableStock([
    product({ stock: 4, producto_variantes: [variant(11, 2, "Negra"), variant(12, 2, "Verde")] }),
  ], [total(1, 1, 11, null, 1)])
  assert.equal(getQuantityLimitMessage(variants, "variant:11", 1), STOCK_LIMIT_RESERVED_MESSAGE)
  assert.equal(getQuantityLimitMessage(variants, "variant:12", 2), STOCK_LIMIT_EXHAUSTED_MESSAGE)

  // Stock con descuento reservado por otra cuenta.
  const [discounted] = applyAvailableStock(
    [product({ stock: 0, conditioned_stock: [conditioned("c-1", 1)] })],
    [total(1, 1, null, "c-1", 1)],
  )
  assert.equal(getQuantityLimitMessage(discounted, "conditioned:c-1", 0), STOCK_LIMIT_RESERVED_MESSAGE)

  assert.equal(
    STOCK_LIMIT_RESERVED_MESSAGE,
    "No hay más unidades disponibles ahora. Otro cliente tiene reservadas las unidades restantes. Si su compra vence o se cancela, volverán a estar disponibles.",
  )
  assert.equal(STOCK_LIMIT_EXHAUSTED_MESSAGE, "No hay más unidades disponibles.")
})

test("bloqueo del +: reserva propia (otra pestaña/dispositivo) o de origen incierto -> texto neutro", () => {
  // Reserva de la misma cuenta en otra sesión: la base no la cuenta como ajena.
  const [own] = applyAvailableStock([product({ stock: 3 })], [total(1, 1, null, null, 0)])
  assert.equal(getQuantityLimitMessage(own, "default", 2), STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE)
  // Invitado o consulta sin sesión: tampoco hay certeza.
  const [unknown] = applyAvailableStock([product({ stock: 1 })], [total(1, 1)])
  assert.equal(getQuantityLimitMessage(unknown, "default", 0), STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE)
  // Mezcla: 1 ajena + 1 propia sobre físico 3, con 1 en el carrito. Si sólo
  // existiera la ajena todavía se podría sumar: no se culpa a "otro cliente".
  const [mixed] = applyAvailableStock([product({ stock: 3 })], [total(1, 2, null, null, 1)])
  assert.equal(getQuantityLimitMessage(mixed, "default", 1), STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE)
  // Si las ajenas alcanzan solas para bloquear, se mantiene "Otro cliente…".
  const [foreignEnough] = applyAvailableStock([product({ stock: 3 })], [total(1, 3, null, null, 2)])
  assert.equal(getQuantityLimitMessage(foreignEnough, "default", 1), STOCK_LIMIT_RESERVED_MESSAGE)
  // Nunca más "ajeno" que lo reservado, aunque la fila venga inconsistente.
  const [capped] = applyAvailableStock([product({ stock: 3 })], [total(1, 1, null, null, 9)])
  assert.equal(capped.foreign_reserved_stock, 1)
  // Variante con descuento reservada por la propia cuenta.
  const [ownDiscounted] = applyAvailableStock(
    [product({ stock: 0, conditioned_stock: [conditioned("c-1", 1)] })],
    [total(1, 1, null, "c-1", 0)],
  )
  assert.equal(getQuantityLimitMessage(ownDiscounted, "conditioned:c-1", 0), STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE)
  assert.equal(
    STOCK_LIMIT_RESERVED_NEUTRAL_MESSAGE,
    "Hay unidades temporalmente reservadas. Si la reserva vence o se cancela, volverán a estar disponibles.",
  )
})

test("Admin: detalle de reservas sin datos del cliente y con estado básico", () => {
  const checkout = describeStockReservation({
    variant_id: 11, conditioned_stock_id: null, quantity: 2,
    expires_at: "2026-09-26T15:20:00+00:00", order_id: null,
  })
  assert.deepEqual(checkout, {
    variantId: 11, conditionedStockId: null, quantity: 2,
    expiresAt: "2026-09-26T15:20:00.000Z", orderId: null, status: "checkout",
  })
  assert.equal(describeStockReservation({
    variant_id: null, conditioned_stock_id: null, quantity: 1,
    expires_at: "2026-09-26T15:20:00+00:00", order_id: 77,
  }).status, "order_pending")
  const held = describeStockReservation({
    variant_id: null, conditioned_stock_id: null, quantity: 1, expires_at: "infinity", order_id: 78,
  })
  assert.equal(held.status, "payment_in_process")
  assert.equal(held.expiresAt, null)
  assert.deepEqual(Object.keys(checkout).sort(), ["conditionedStockId", "expiresAt", "orderId", "quantity", "status", "variantId"])
})
