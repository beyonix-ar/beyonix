import type { createAdminClient } from "../supabase/admin.ts"
import { STOCK_CHANGED_MESSAGE } from "../cart/stock-status.ts"
import { getProductDiscount } from "../store-config.ts"

export interface CheckoutConditionedItem {
  productId: number
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
}

export interface ConditionedCheckoutRow {
  id: string
  product_id: number
  source_variant_id: number | null
  name: string
  sku: string
  color_hex: string
  images: string[]
  original_quantity: number
  sold_quantity: number
  available_quantity: number
  discount_percent: number
  reason: string | null
  active?: boolean
}

type AdminClient = ReturnType<typeof createAdminClient>

export function normalizeConditionedStockId(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalized,
  )
    ? normalized
    : null
}

export async function loadConditionedCheckoutRows(
  admin: AdminClient,
  items: CheckoutConditionedItem[],
) {
  const ids = [
    ...new Set(
      items
        .map((item) => item.conditionedStockId)
        .filter((id): id is string => Boolean(id)),
    ),
  ]
  const result = new Map<string, ConditionedCheckoutRow>()
  if (!ids.length) return result

  const { data, error } = await admin
    .from("conditioned_inventory_offers")
    .select(
      "id, product_id, source_variant_id, name, sku, color_hex, images, original_quantity, sold_quantity, available_quantity, discount_percent, reason, active",
    )
    .in("id", ids)

  if (error) {
    if (
      /conditioned_inventory_offers|schema cache|does not exist/i.test(
        error.message,
      )
    ) {
      throw new Error(
        "Falta aplicar la migración de variantes con descuento.",
      )
    }
    throw new Error("No se pudieron validar las variantes con descuento.")
  }

  for (const rawRow of data ?? []) {
    const row = rawRow as unknown as ConditionedCheckoutRow
    result.set(String(row.id), {
      ...row,
      id: String(row.id),
      product_id: Number(row.product_id),
      source_variant_id:
        row.source_variant_id == null
          ? null
          : Number(row.source_variant_id),
      images: Array.isArray(row.images)
        ? row.images.filter(
            (image): image is string => typeof image === "string",
          )
        : [],
      original_quantity: Number(row.original_quantity) || 0,
      sold_quantity: Number(row.sold_quantity) || 0,
      available_quantity: Number(row.available_quantity) || 0,
      discount_percent: Number(row.discount_percent) || 0,
      active: row.active === true,
    })
  }

  if (result.size !== ids.length) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }

  return result
}

export function assertConditionedCheckoutStock(
  item: CheckoutConditionedItem,
  rows: Map<string, ConditionedCheckoutRow>,
) {
  if (!item.conditionedStockId) return null

  const row = rows.get(item.conditionedStockId)
  if (
    !row ||
    !row.active ||
    row.product_id !== item.productId ||
    row.available_quantity < item.quantity ||
    row.discount_percent <= 0 ||
    row.discount_percent >= 100
  ) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }

  return row
}

export function getConditionedUnitPrice(
  basePrice: number,
  row?: Pick<ConditionedCheckoutRow, "discount_percent"> | null,
) {
  const safeBasePrice = Number.isFinite(basePrice)
    ? Math.max(basePrice, 0)
    : 0
  if (!row) return safeBasePrice

  return Math.max(
    Math.round(safeBasePrice * (1 - row.discount_percent / 100)),
    0,
  )
}

/**
 * Precio unitario canónico que se persiste en `orden_items`: primero aplica
 * la condición particular de la unidad y después la campaña comercial del
 * producto. Cotización logística y creación de orden deben usar este mismo
 * redondeo para declarar exactamente el mismo valor de mercadería.
 */
export function getCheckoutOrderItemUnitPrice(
  productId: number,
  basePrice: number,
  conditioned?: Pick<ConditionedCheckoutRow, "discount_percent"> | null,
) {
  return Math.round(
    getConditionedUnitPrice(basePrice, conditioned) *
      (1 - getProductDiscount(productId)),
  )
}

export function getConditionedOrderItemFields(
  row?: ConditionedCheckoutRow | null,
) {
  if (!row) return {}

  return {
    variante_id: null,
    conditioned_stock_id: row.id,
    conditioned_name: row.name,
    conditioned_sku: row.sku,
    conditioned_color_hex: row.color_hex,
    conditioned_images: row.images,
    conditioned_discount_percent: row.discount_percent,
    conditioned_reason: row.reason,
  }
}
