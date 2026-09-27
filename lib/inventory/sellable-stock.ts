/**
 * Fase 5 — fuente única de stock vendible para catálogo, carrito, checkout y
 * Admin:
 *
 *   disponible = stock físico - reservas activas   (nunca negativo)
 *
 * El físico es el stock derivado (`productos.stock`, `producto_variantes.stock`,
 * `conditioned_inventory_offers.available_quantity`). Lo reservado sale de la
 * RPC `active_stock_reservation_totals` (supabase/migrations/20260926130000),
 * que agrega `stock_reservations` con el MISMO predicado que usa la base para
 * reservar y confirmar (`expires_at > now()`). Una reserva vencida deja de
 * contar sin tocar el físico.
 *
 * Esto es sólo lectura/UX: la autoridad sigue siendo `reserve_cart_stock` y
 * los commits de pago, bajo advisory locks.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { SupabaseProducto } from "../supabase/types.ts"

export interface ActiveReservationTotal {
  product_id: number
  variant_id: number | null
  conditioned_stock_id: string | null
  reserved_quantity: number
}

/** Mismo límite que valida la RPC; los listados grandes se piden en lotes. */
const RESERVATION_TOTALS_BATCH_SIZE = 500

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0
}

/** Disponible para vender. Nunca negativo, aunque lo reservado supere al físico. */
export function calculateAvailableStock(physical: unknown, reserved: unknown) {
  return Math.max(0, nonNegativeInteger(physical) - nonNegativeInteger(reserved))
}

export interface ProductReservationSummary {
  /** Stock normal (producto sin variantes o suma de sus variantes). */
  normal: number
  byVariant: Map<number, number>
  byConditioned: Map<string, number>
}

/**
 * Agrupa las reservas activas de un producto. `productos.stock` es el total
 * del producto (incluye lo asignado a cada variante), así que lo reservado
 * sobre cualquier variante también descuenta del total; el stock condicionado
 * (con descuento) es un pool aparte y sólo descuenta de su propia oferta.
 */
export function summarizeProductReservations(
  productId: number,
  totals: readonly ActiveReservationTotal[],
): ProductReservationSummary {
  const summary: ProductReservationSummary = {
    normal: 0,
    byVariant: new Map(),
    byConditioned: new Map(),
  }
  for (const row of totals) {
    if (Number(row.product_id) !== productId) continue
    const quantity = nonNegativeInteger(row.reserved_quantity)
    if (row.conditioned_stock_id) {
      const id = String(row.conditioned_stock_id)
      summary.byConditioned.set(id, (summary.byConditioned.get(id) ?? 0) + quantity)
      continue
    }
    summary.normal += quantity
    if (row.variant_id != null) {
      const id = Number(row.variant_id)
      summary.byVariant.set(id, (summary.byVariant.get(id) ?? 0) + quantity)
    }
  }
  return summary
}

function groupTotalsByProduct(totals: readonly ActiveReservationTotal[]) {
  const byProduct = new Map<number, ActiveReservationTotal[]>()
  for (const row of totals) {
    const productId = Number(row.product_id)
    byProduct.set(productId, [...(byProduct.get(productId) ?? []), row])
  }
  return byProduct
}

function withReservations<T extends SupabaseProducto>(
  product: T,
  totals: readonly ActiveReservationTotal[],
  exposeAvailableAsStock: boolean,
): T {
  const summary = summarizeProductReservations(product.id, totals)
  const physical = nonNegativeInteger(product.physical_stock ?? product.stock)
  const resolve = (physicalValue: number, reserved: number) =>
    exposeAvailableAsStock ? calculateAvailableStock(physicalValue, reserved) : physicalValue

  return {
    ...product,
    stock: resolve(physical, summary.normal),
    physical_stock: physical,
    reserved_stock: summary.normal,
    producto_variantes: product.producto_variantes?.map((variant) => {
      const variantPhysical = nonNegativeInteger(variant.physical_stock ?? variant.stock)
      const reserved = summary.byVariant.get(variant.id) ?? 0
      return {
        ...variant,
        stock: resolve(variantPhysical, reserved),
        physical_stock: variantPhysical,
        reserved_stock: reserved,
      }
    }),
    conditioned_stock: product.conditioned_stock?.map((item) => {
      const itemPhysical = nonNegativeInteger(item.physical_quantity ?? item.quantity)
      const reserved = summary.byConditioned.get(item.id) ?? 0
      return {
        ...item,
        quantity: resolve(itemPhysical, reserved),
        physical_quantity: itemPhysical,
        reserved_quantity: reserved,
      }
    }),
  }
}

/**
 * Catálogo público, carrito y checkout: `stock` (producto, variantes y stock
 * condicionado) pasa a ser el DISPONIBLE. Conserva `physical_*`/`reserved_*`.
 * Idempotente: volver a aplicarlo parte del físico guardado, no del disponible.
 */
export function applyAvailableStock<T extends SupabaseProducto>(
  products: T[],
  totals: readonly ActiveReservationTotal[],
): T[] {
  const byProduct = groupTotalsByProduct(totals)
  return products.map((product) =>
    withReservations(product, byProduct.get(product.id) ?? [], true),
  )
}

/** Admin: `stock` sigue siendo el físico; agrega lo reservado para mostrar físico/reservado/disponible. */
export function attachReservedStock<T extends SupabaseProducto>(
  products: T[],
  totals: readonly ActiveReservationTotal[],
): T[] {
  const byProduct = groupTotalsByProduct(totals)
  return products.map((product) =>
    withReservations(product, byProduct.get(product.id) ?? [], false),
  )
}

function isMissingReservationTotalsRpc(message: string) {
  return /active_stock_reservation_totals|PGRST202|schema cache|does not exist/i.test(message)
}

/**
 * Reservas activas de muchos productos en una sola consulta por lote (sin
 * N+1 ni lecturas reserva por reserva). Si la migración todavía no se aplicó
 * devuelve [] (se muestra el físico, como antes de la Fase 5): el backend
 * sigue rechazando cualquier reserva sin stock.
 */
export async function fetchActiveReservationTotals(
  client: SupabaseClient,
  productIds: readonly number[],
  options: { excludeSessionId?: string | null } = {},
): Promise<ActiveReservationTotal[]> {
  const ids = [...new Set(productIds.filter((id) => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return []

  const batches: number[][] = []
  for (let index = 0; index < ids.length; index += RESERVATION_TOTALS_BATCH_SIZE) {
    batches.push(ids.slice(index, index + RESERVATION_TOTALS_BATCH_SIZE))
  }

  const results = await Promise.all(batches.map((batch) =>
    client.rpc("active_stock_reservation_totals", {
      p_product_ids: batch,
      p_exclude_session_id: options.excludeSessionId || null,
    }),
  ))

  const totals: ActiveReservationTotal[] = []
  for (const { data, error } of results) {
    if (error) {
      if (isMissingReservationTotalsRpc(error.message)) return []
      throw error
    }
    for (const row of (data ?? []) as ActiveReservationTotal[]) {
      totals.push({
        product_id: Number(row.product_id),
        variant_id: row.variant_id == null ? null : Number(row.variant_id),
        conditioned_stock_id: row.conditioned_stock_id == null ? null : String(row.conditioned_stock_id),
        reserved_quantity: nonNegativeInteger(row.reserved_quantity),
      })
    }
  }
  return totals
}
