import "server-only"

import { createAdminClient } from "@/lib/supabase/admin"
import {
  buildProductCostLedgers,
  getWorstCaseKnownCost,
  resolveProductVariantCosts,
  type ProductCostLedgerRow,
  type VariantCostResolution,
} from "@/lib/business/product-costs"

export interface ProductKnownCost {
  knownUnitCost: number | null
  variantCosts: VariantCostResolution[]
  /** Ids de las variantes que hoy están activas (vendibles) en la base. */
  activeVariantIds: number[]
}

interface ProductVariantRow {
  id: number
  nombre: string | null
  activo: boolean | null
}

/**
 * Trae de Supabase lo necesario (variantes del producto + libro de compras)
 * y delega la resolución en las funciones puras de
 * lib/business/product-costs.ts. Única fuente compartida entre el endpoint
 * de lectura (app/api/admin/products/[id]/pricing) y el de guardado
 * autoritativo (app/api/admin/products/[id]/catalog) -- nunca pueden
 * calcular el costo de forma distinta entre sí.
 *
 * Se traen `received_quantity` y `reception_status` porque una compra
 * pendiente, parcial o anulada NO representa mercadería incorporada al
 * inventario y no puede formar el costo con el que se fija precio (ver
 * `getReceivedCostContribution`).
 */
export async function resolveProductKnownCost(
  admin: ReturnType<typeof createAdminClient>,
  productId: number,
): Promise<ProductKnownCost> {
  const [variantsResult, costRowsResult] = await Promise.all([
    admin
      .from("producto_variantes")
      .select("id, nombre, activo")
      .eq("producto_id", productId),
    admin
      .from("product_cost_entries")
      .select(
        "product_id, variant_id, purchase_date, quantity, received_quantity, reception_status, total_cost",
      )
      .eq("product_id", productId),
  ])

  if (variantsResult.error) {
    throw new Error("No se pudieron consultar las variantes del producto.")
  }
  if (costRowsResult.error) {
    throw new Error("No se pudo consultar el costo del producto.")
  }

  const variants = (variantsResult.data ?? []) as ProductVariantRow[]
  const ledgers = buildProductCostLedgers(
    (costRowsResult.data ?? []) as ProductCostLedgerRow[],
  )
  const variantCosts = resolveProductVariantCosts(
    ledgers,
    productId,
    variants,
    new Date().toISOString(),
  )

  return {
    knownUnitCost: getWorstCaseKnownCost(variantCosts),
    variantCosts,
    activeVariantIds: variants
      .filter((variant) => variant.activo !== false)
      .map((variant) => variant.id),
  }
}
