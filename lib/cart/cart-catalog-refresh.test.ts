import assert from "node:assert/strict"
import test from "node:test"

import {
  COMMERCIAL_REFRESH_MIN_GAP_MS,
  getCartCommercialSignature,
  getCommercialSettingsSignature,
  reconcileCartWithCatalog,
  shouldRunCommercialRefresh,
  type RefreshableCartItem,
} from "./cart-catalog-refresh.ts"
import { getCartStockIssues } from "./stock-status.ts"
import type { SupabaseProducto, SupabaseProductoVariante } from "../supabase/types.ts"

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
    cuotas_2_habilitadas: true,
    cuotas_3_habilitadas: true,
    cuotas_6_habilitadas: true,
    ...overrides,
  } as unknown as SupabaseProducto
}

function makeItem(product: SupabaseProducto, overrides: Partial<RefreshableCartItem> = {}): RefreshableCartItem {
  return {
    product,
    color: "default",
    quantity: 1,
    variantId: null,
    conditionedStockId: null,
    variantName: "Default",
    colorHex: null,
    unitPrice: product.precio,
    originalUnitPrice: null,
    discountReason: null,
    ...overrides,
  }
}

test("activar 'Mismo precio en contado y cuotas' en Admin refresca el carrito abierto", () => {
  const items = [makeItem(makeProduct())]
  const result = reconcileCartWithCatalog(items, [makeProduct({ cuotas_sin_recargo: true })])
  assert.equal(result.changed, true)
  assert.equal(result.items[0].product.cuotas_sin_recargo, true)
  // Snapshot viejo sin la clave (sessionStorage previo a la columna) = OFF: no cambia nada.
  assert.equal(reconcileCartWithCatalog(items, [makeProduct({ cuotas_sin_recargo: false })]).changed, false)
})

test("sin cambios comerciales el carrito NO se altera (misma referencia, sin re-render)", () => {
  const items = [makeItem(makeProduct())]
  const result = reconcileCartWithCatalog(items, [makeProduct()])
  assert.equal(result.changed, false)
  assert.equal(result.items, items)
  assert.equal(result.removed.length, 0)
})

test("detecta el cambio de precio del Admin y actualiza precio unitario y producto", () => {
  const items = [makeItem(makeProduct({ precio: 46_000 }), { quantity: 2 })]
  const result = reconcileCartWithCatalog(items, [makeProduct({ precio: 1_000 })])
  assert.equal(result.changed, true)
  assert.equal(result.items[0].unitPrice, 1_000)
  assert.equal(result.items[0].product.precio, 1_000)
  assert.equal(result.items[0].quantity, 2, "la cantidad elegida por el cliente se conserva")
  assert.notEqual(
    getCartCommercialSignature(result.items),
    getCartCommercialSignature(items),
  )
})

test("detecta el cambio de cuotas habilitadas (máximo de cuotas)", () => {
  const items = [makeItem(makeProduct())]
  const result = reconcileCartWithCatalog(items, [makeProduct({ cuotas_6_habilitadas: false })])
  assert.equal(result.changed, true)
  assert.equal(result.items[0].product.cuotas_6_habilitadas, false)
})

test("producto desactivado/borrado se quita del carrito y se informa", () => {
  const product = makeProduct()
  const items = [makeItem(product)]

  const deactivated = reconcileCartWithCatalog(items, [])
  assert.equal(deactivated.changed, true)
  assert.equal(deactivated.items.length, 0)
  assert.equal(deactivated.removed.length, 1)
})

test("Fase 5: sin stock disponible la línea NO se borra en silencio; queda marcada con el stock vigente", () => {
  const items = [makeItem(makeProduct(), { quantity: 2 })]
  const outOfStock = reconcileCartWithCatalog(items, [makeProduct({ stock: 0 })])
  assert.equal(outOfStock.changed, true)
  assert.equal(outOfStock.items.length, 1)
  assert.equal(outOfStock.removed.length, 0)
  assert.equal(outOfStock.items[0].quantity, 2, "la cantidad la corrige el cliente, no el refresco")
  assert.deepEqual(getCartStockIssues(outOfStock.items), [
    { productId: 101, color: "default", requested: 2, available: 0 },
  ])
})

test("Fase 5: un cambio del disponible dentro del rango comprable (0 a 3) refresca la línea", () => {
  const items = [makeItem(makeProduct({ stock: 3 }), { quantity: 3 })]
  // 3 -> 2 sigue siendo "Últimas unidades": igual debe refrescar el snapshot.
  const reduced = reconcileCartWithCatalog(items, [makeProduct({ stock: 2 })])
  assert.equal(reduced.changed, true)
  assert.equal(reduced.items[0].product.stock, 2)
  assert.deepEqual(getCartStockIssues(reduced.items), [
    { productId: 101, color: "default", requested: 3, available: 2 },
  ])
  // Fuera del rango comprable (50 -> 40) no hay re-render.
  const plenty = [makeItem(makeProduct({ stock: 50 }))]
  assert.equal(reconcileCartWithCatalog(plenty, [makeProduct({ stock: 40 })]).items, plenty)
})

test("una variante que dejó de existir se quita (nunca se cambia por otra en silencio)", () => {
  const variant = {
    id: 7,
    producto_id: 101,
    nombre: "Negro",
    color_hex: "#000000",
    stock: 5,
    activo: true,
    orden: 1,
    imagenes: [],
    sku: "TRI-NEG",
  } as unknown as SupabaseProductoVariante
  const product = makeProduct({ producto_variantes: [variant] })
  const items = [makeItem(product, { color: "variant:7", variantId: 7 })]
  const withoutVariant = makeProduct({
    producto_variantes: [{ ...variant, id: 8, nombre: "Blanco" }],
  })

  const result = reconcileCartWithCatalog(items, [withoutVariant])
  assert.equal(result.changed, true)
  assert.equal(result.items.length, 0)
})

test("la configuración comercial (transferencia, fees, envío) cambia la firma", () => {
  const base = {
    shipping: { freeShippingThreshold: 100_000 },
    installmentsFinancing: { baseProcessingPercent: 6.42 },
    pricing: { transferDiscountPercent: 10 },
  }
  assert.equal(getCommercialSettingsSignature(base), getCommercialSettingsSignature({ ...base }))
  assert.notEqual(
    getCommercialSettingsSignature(base),
    getCommercialSettingsSignature({ ...base, pricing: { transferDiscountPercent: 15 } }),
  )
})

test("el refresco sólo corre con la pestaña visible, sin otro en curso y respetando el mínimo; un 409 lo fuerza", () => {
  const now = 1_000_000
  assert.equal(shouldRunCommercialRefresh({ visible: false, inFlight: false, lastRunAt: 0, now }), false)
  assert.equal(shouldRunCommercialRefresh({ visible: true, inFlight: true, lastRunAt: 0, now }), false)
  assert.equal(
    shouldRunCommercialRefresh({ visible: true, inFlight: false, lastRunAt: now - 1_000, now }),
    false,
  )
  assert.equal(
    shouldRunCommercialRefresh({
      visible: true,
      inFlight: false,
      lastRunAt: now - COMMERCIAL_REFRESH_MIN_GAP_MS,
      now,
    }),
    true,
  )
  assert.equal(
    shouldRunCommercialRefresh({ visible: false, inFlight: false, lastRunAt: now, now, force: true }),
    true,
  )
  assert.equal(
    shouldRunCommercialRefresh({ visible: true, inFlight: true, lastRunAt: 0, now, force: true }),
    false,
    "nunca dos lecturas en paralelo",
  )
})
