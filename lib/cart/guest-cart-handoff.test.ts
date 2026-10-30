import assert from "node:assert/strict"
import test from "node:test"

import { normalizeCart, type CartItem } from "./cart-items.ts"
import { reconcileCartWithCatalog } from "./cart-catalog-refresh.ts"
import { getCartStockIssues } from "./stock-status.ts"
import {
  resolveCartOnSignIn,
  resolveCartOnSignOut,
  type CartAuthOwner,
} from "./guest-cart-handoff.ts"
import type { SupabaseProducto, SupabaseProductoVariante } from "../supabase/types.ts"

const GUEST: CartAuthOwner = { kind: "guest" }
const USER_ID = "user-1"

function makeVariant(id: number, nombre: string): SupabaseProductoVariante {
  return {
    id,
    producto_id: 101,
    nombre,
    color_hex: "#000000",
    stock: 10,
    activo: true,
    orden: id,
    imagenes: [],
    sku: `TRI-${id}`,
  } as unknown as SupabaseProductoVariante
}

function makeProduct(overrides: Partial<SupabaseProducto> = {}): SupabaseProducto {
  return {
    id: 101,
    nombre: "Trípode Pro",
    precio: 46_000,
    precio_anterior: null,
    descuento: null,
    stock: 10,
    activo: true,
    sku: "TRI-01",
    imagen_principal: null,
    imagenes_producto: [],
    producto_variantes: [],
    conditioned_stock: [],
    ...overrides,
  } as unknown as SupabaseProducto
}

const tripod = makeProduct({ producto_variantes: [makeVariant(7, "Negro"), makeVariant(8, "Blanco")] })
const lamp = makeProduct({ id: 202, nombre: "Lámpara Peña", precio: 12_500, sku: "LAM-01" })
const ring = makeProduct({ id: 303, nombre: "Aro de luz", precio: 30_000, sku: "ARO-01" })

// Como llega desde sessionStorage/localStorage: JSON -> normalizeCart.
function storedCart(lines: Array<{ product: SupabaseProducto; color: string; quantity: number; variantId?: number | null }>) {
  return normalizeCart(JSON.parse(JSON.stringify(lines.map((line) => ({
    product: line.product,
    color: line.color,
    quantity: line.quantity,
    variantId: line.variantId ?? null,
    unitPrice: line.product.precio,
  })))))
}

const summary = (cart: CartItem[]) => cart.map((item) => `${item.product.id}:${item.color}:${item.quantity}`)

test("merge: invitado 3 + cuenta 2 conserva 5 si hay stock; la restauración no recorta", () => {
  const guest = storedCart([{ product: tripod, color: "variant:7", variantId: 7, quantity: 3 }])
  const account = storedCart([{ product: tripod, color: "variant:7", variantId: 7, quantity: 2 }])
  const { cart } = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guest, storedAccountCart: account })
  assert.deepEqual(summary(cart), ["101:variant:7:5"])
  assert.deepEqual(summary(normalizeCart(JSON.parse(JSON.stringify(cart)))), ["101:variant:7:5"])
})

test("merge: la suma se ajusta al stock disponible de ambos snapshots", () => {
  const guestProduct = makeProduct({ producto_variantes: [{ ...makeVariant(7, "Negro"), stock: 4 }] })
  const accountProduct = makeProduct({ producto_variantes: [{ ...makeVariant(7, "Negro"), stock: 5 }] })
  const guest = storedCart([{ product: guestProduct, color: "variant:7", variantId: 7, quantity: 3 }])
  const account = storedCart([{ product: accountProduct, color: "variant:7", variantId: 7, quantity: 2 }])
  const { cart } = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guest, storedAccountCart: account })
  assert.deepEqual(summary(cart), ["101:variant:7:4"])
  assert.deepEqual(summary(guest), ["101:variant:7:3"])
  assert.deepEqual(summary(account), ["101:variant:7:2"])
})

const guestCart = storedCart([
  { product: tripod, color: "variant:7", quantity: 2, variantId: 7 },
  { product: tripod, color: "variant:8", quantity: 1, variantId: 8 },
  { product: lamp, color: "default", quantity: 3 },
])

test("C. invitado confirmado sin carrito previo en la cuenta: conserva exactamente su carrito", () => {
  const { cart, handoff } = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guestCart, storedAccountCart: [] })
  assert.deepEqual(summary(cart), ["101:variant:7:2", "101:variant:8:1", "202:default:3"])
  assert.deepEqual(cart.map((item) => item.variantId), [7, 8, null])
  // Restaurado de storage y refrescado contra el mismo catálogo: no se pierde nada.
  assert.equal(reconcileCartWithCatalog(cart, [tripod, lamp]).removed.length, 0)
  assert.deepEqual(cart.map((item) => item.unitPrice), [46_000, 46_000, 12_500])
  assert.ok(handoff)
  assert.equal(handoff.userId, USER_ID)
})

test("H. la cuenta ya tenía carrito: unión determinista con la regla existente, sin pérdida silenciosa", () => {
  const accountCart = storedCart([
    { product: lamp, color: "default", quantity: 1 },
    { product: tripod, color: "variant:7", quantity: 1, variantId: 7 },
    { product: ring, color: "default", quantity: 1 },
  ])
  const { cart } = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guestCart, storedAccountCart: accountCart })

  // Líneas del invitado primero (orden intacto); misma producto+variante suma
  // hasta el disponible, sin el viejo tope de 3.
  assert.deepEqual(summary(cart), ["101:variant:7:3", "101:variant:8:1", "202:default:4", "303:default:1"])
  // Determinista: misma entrada, mismo resultado; las entradas no se mutan.
  assert.deepEqual(summary(resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guestCart, storedAccountCart: accountCart }).cart), summary(cart))
  assert.deepEqual(summary(guestCart), ["101:variant:7:2", "101:variant:8:1", "202:default:3"])
  assert.deepEqual(summary(accountCart), ["202:default:1", "101:variant:7:1", "303:default:1"])
})

test("sesión ya existente al cargar (o todavía sin resolver): restaura la cuenta y nunca suma dos veces", () => {
  const accountCart = storedCart([{ product: lamp, color: "default", quantity: 2 }])
  // El sessionStorage de un usuario logueado ya ES su carrito: sumarlo lo duplicaría.
  const sameCart = storedCart([{ product: lamp, color: "default", quantity: 2 }])

  for (const owner of [{ kind: "unknown" }, { kind: "user", userId: USER_ID }] as CartAuthOwner[]) {
    const { cart, handoff } = resolveCartOnSignIn({ owner, userId: USER_ID, currentCart: sameCart, storedAccountCart: accountCart })
    assert.equal(cart, accountCart)
    assert.equal(handoff, null)
  }
})

test("un segundo SIGNED_IN/TOKEN_REFRESHED después del traspaso no vuelve a sumar", () => {
  const first = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guestCart, storedAccountCart: [] })
  // cart-context persiste el carrito unido y pasa el dueño a la cuenta.
  const persisted = normalizeCart(JSON.parse(JSON.stringify(first.cart)))
  const second = resolveCartOnSignIn({ owner: { kind: "user", userId: USER_ID }, userId: USER_ID, currentCart: first.cart, storedAccountCart: persisted })
  assert.deepEqual(summary(second.cart), summary(first.cart))
})

test("invitado con carrito vacío: comportamiento anterior (carrito de la cuenta)", () => {
  const accountCart = storedCart([{ product: ring, color: "default", quantity: 1 }])
  const { cart, handoff } = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: [], storedAccountCart: accountCart })
  assert.equal(cart, accountCart)
  assert.equal(handoff, null)
})

test("E. sesión rechazada enseguida (cuenta sin activar -> signOut): vuelve el carrito del invitado intacto", () => {
  const accountCart = storedCart([{ product: ring, color: "default", quantity: 1 }])
  const signIn = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guestCart, storedAccountCart: accountCart })
  const signOut = resolveCartOnSignOut(signIn.handoff)

  assert.deepEqual(summary(signOut.cart), summary(guestCart))
  assert.deepEqual(signOut.restoreAccount, { userId: USER_ID, cart: accountCart })
})

test("logout real (sin traspaso pendiente): vacía el carrito como siempre", () => {
  assert.deepEqual(resolveCartOnSignOut(null), { cart: [], restoreAccount: null })
})

test("I. precio/stock cambian mientras se autentica: reconciliación normal, sin perder el carrito", () => {
  const { cart } = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guestCart, storedAccountCart: [] })
  const freshTripod = makeProduct({
    precio: 48_000,
    producto_variantes: [makeVariant(7, "Negro"), { ...makeVariant(8, "Blanco"), stock: 0 }],
  })
  const freshLamp = makeProduct({ id: 202, nombre: "Lámpara Peña", precio: 12_500, sku: "LAM-01", stock: 2 })

  const result = reconcileCartWithCatalog(cart, [freshTripod, freshLamp])

  assert.equal(result.changed, true)
  assert.equal(result.removed.length, 0)
  assert.equal(result.items.length, 3)
  assert.equal(result.priceChanged, true)
  assert.equal(result.items[0].unitPrice, 48_000)
  // Sin stock / menos stock: la línea queda marcada (bloquea avanzar), no se borra.
  assert.deepEqual(getCartStockIssues(result.items), [
    { productId: 101, color: "variant:8", requested: 1, available: 0 },
    { productId: 202, color: "default", requested: 3, available: 2 },
  ])
})

test("I. producto desactivado durante el login: sólo se quita esa línea", () => {
  const { cart } = resolveCartOnSignIn({ owner: GUEST, userId: USER_ID, currentCart: guestCart, storedAccountCart: [] })
  const result = reconcileCartWithCatalog(cart, [tripod, { ...lamp, activo: false }])
  assert.deepEqual(result.removed.map((item) => item.product.id), [202])
  assert.deepEqual(summary(result.items), ["101:variant:7:2", "101:variant:8:1"])
})
