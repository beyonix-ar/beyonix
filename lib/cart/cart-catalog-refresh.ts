/**
 * Refresco del carrito contra el catálogo VIGENTE (precio, variante, stock,
 * cuotas habilitadas) mientras el cliente tiene abierto carrito/checkout.
 *
 * Es sólo UX: el carrito vive en sessionStorage con un snapshot del producto
 * tomado al agregarlo, y antes nunca se refrescaba. La seguridad NO depende
 * de esto -- el botón Pagar siempre recalcula todo server-side
 * (`/api/mercadopago/create-preference`, transferencia, saldo).
 *
 * Funciones puras: sin fetch ni React, testeables en `node --test`.
 */

import { getVariantOptionByValue } from "../products/product-variants.ts"
import { getProductStock, getStockStatus } from "./stock-status.ts"
import type { SupabaseProducto } from "../supabase/types.ts"

export interface RefreshableCartItem {
  product: SupabaseProducto
  color: string
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
  variantName: string | null
  colorHex: string | null
  unitPrice: number
  originalUnitPrice: number | null
  discountReason: string | null
}

/**
 * Lo que, si cambia, cambia lo que el cliente paga o puede comprar. La
 * cantidad exacta de stock queda afuera a propósito (el frontend nunca la
 * expone): sólo cuenta el estado agotado/bajo/disponible.
 */
function getCartItemCommercialKey(item: RefreshableCartItem) {
  return JSON.stringify([
    item.product.id,
    item.color,
    item.quantity,
    item.variantId,
    item.conditionedStockId,
    item.unitPrice,
    item.originalUnitPrice,
    item.discountReason,
    item.product.precio,
    Boolean(item.product.cuotas_2_habilitadas),
    Boolean(item.product.cuotas_3_habilitadas),
    Boolean(item.product.cuotas_6_habilitadas),
    getStockStatus(item.product, item.color),
  ])
}

export function getCartCommercialSignature(items: RefreshableCartItem[]) {
  return items.map(getCartItemCommercialKey).join("|")
}

export interface CartCatalogReconciliation<T extends RefreshableCartItem> {
  items: T[]
  /** `true` si cambió algo que afecta precio, cuotas, stock o qué hay en el carrito. */
  changed: boolean
  /** Líneas que se quitaron porque el producto/variante ya no se vende. */
  removed: T[]
}

/**
 * Aplica el catálogo fresco a los ítems del carrito. Si nada comercialmente
 * relevante cambió, devuelve EXACTAMENTE el mismo array (misma referencia):
 * el carrito no se toca ni se re-renderiza. Un producto desactivado, borrado,
 * o una variante que ya no existe o quedó sin stock se quitan (mismo criterio
 * que la hidratación del carrito, `normalizeCart`).
 */
export function reconcileCartWithCatalog<T extends RefreshableCartItem>(
  items: T[],
  freshProducts: SupabaseProducto[],
): CartCatalogReconciliation<T> {
  const productsById = new Map(freshProducts.map((product) => [product.id, product]))
  const removed: T[] = []
  let changed = false

  const next = items.flatMap((item) => {
    const fresh = productsById.get(item.product.id)

    if (!fresh || fresh.activo === false) {
      removed.push(item)
      changed = true
      return []
    }

    // Conserva relaciones que la consulta liviana no trae (categorías,
    // especificaciones) y pisa todo lo comercial con el valor vigente.
    const product = { ...item.product, ...fresh } as SupabaseProducto
    const variant = getVariantOptionByValue(product, item.color)
    const sameVariant =
      variant != null &&
      variant.value === item.color &&
      (variant.id ?? null) === (item.variantId ?? null) &&
      (variant.conditionedStockId ?? null) === (item.conditionedStockId ?? null)

    if (!sameVariant || getProductStock(product, item.color) <= 0) {
      removed.push(item)
      changed = true
      return []
    }

    const refreshed: T = {
      ...item,
      product,
      variantName: variant.name,
      colorHex: variant.colorHex,
      unitPrice: variant.price,
      originalUnitPrice: variant.originalPrice,
      discountReason: variant.reason,
    }

    if (getCartItemCommercialKey(refreshed) !== getCartItemCommercialKey(item)) {
      changed = true
      return [refreshed]
    }

    return [item]
  })

  return { items: changed ? next : items, changed, removed }
}

export const COMMERCIAL_REFRESH_INTERVAL_MS = 30_000
export const COMMERCIAL_REFRESH_MIN_GAP_MS = 5_000

export const COMMERCIAL_UPDATE_NOTICE =
  "Los precios o condiciones de tu compra fueron actualizados."

/**
 * Cuándo corresponde volver a leer catálogo+configuración: sólo con la
 * pestaña visible, sin otra lectura en curso y respetando un mínimo entre
 * lecturas (foco + visibilitychange + intervalo pueden dispararse juntos).
 * `force` (p. ej. después de un 409 PRICING_CHANGED) ignora el mínimo.
 */
export function shouldRunCommercialRefresh({
  visible,
  inFlight,
  lastRunAt,
  now,
  force = false,
}: {
  visible: boolean
  inFlight: boolean
  lastRunAt: number
  now: number
  force?: boolean
}) {
  if (inFlight) return false
  if (force) return true
  if (!visible) return false
  return now - lastRunAt >= COMMERCIAL_REFRESH_MIN_GAP_MS
}

/** Configuración comercial que cambia totales, envío, cuotas o descuentos. */
export function getCommercialSettingsSignature(settings: {
  shipping: unknown
  installmentsFinancing: unknown
  pricing: unknown
}) {
  return JSON.stringify([
    settings.shipping,
    settings.installmentsFinancing,
    settings.pricing,
  ])
}
