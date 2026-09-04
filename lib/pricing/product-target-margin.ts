import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import {
  getTargetMarginCostBasisError,
  resolveTargetMarginCostBasis,
  type VariantCostResolution,
} from "@/lib/business/product-costs"
import { resolveProductKnownCost } from "@/lib/admin/product-known-cost"
import { getSiteSettings } from "@/lib/site-settings"
import type { InstallmentCount } from "@/lib/products/installments"
import { calculateTargetMarginPrice } from "@/lib/pricing/product-pricing"

export interface TargetMarginVariantState {
  id: number
  active: boolean
}

export type TargetMarginPriceResolution =
  | {
      ok: true
      commercialPrice: number
      unitCost: number
      relevantVariantCosts: VariantCostResolution[]
    }
  | {
      ok: false
      /** `missing_variant_cost` y `no_cost` son problemas de datos; `unreachable_margin`, de configuración. */
      reason: "missing_variant_cost" | "no_cost" | "unreachable_margin"
      message: string
      missingVariantCosts: VariantCostResolution[]
    }

/**
 * Variantes que condicionan el precio: sólo las que van a quedar VENDIBLES.
 * Una variante desactivada no puede venderse, así que su costo (conocido o
 * no) no puede bloquear ni mover el precio público.
 *
 * `variantStates` es lo que el Admin está por guardar y manda siempre el
 * editor de producto: gana sobre el estado actual en base para las variantes
 * que menciona. Las que NO menciona conservan su estado real en base -- nunca
 * se asume que una variante ausente del formulario quedó desactivada.
 */
export function selectRelevantVariantCosts(
  variantCosts: VariantCostResolution[],
  activeVariantIds: number[],
  variantStates: TargetMarginVariantState[] | null,
): VariantCostResolution[] {
  const requestedState = new Map(
    (variantStates ?? []).map((state) => [state.id, state.active]),
  )
  const activeIds = new Set(activeVariantIds)

  return variantCosts.filter((entry) => {
    // Producto sin variantes: el costo vive a nivel producto y siempre pesa.
    if (entry.variantId == null) return true

    const requested = requestedState.get(entry.variantId)
    return requested ?? activeIds.has(entry.variantId)
  })
}

export interface ResolveTargetMarginPriceInput {
  admin: ReturnType<typeof createAdminClient>
  productId: number
  targetMarginPercent: number
  eligibleInstallmentCounts: InstallmentCount[]
  variantStates?: TargetMarginVariantState[] | null
}

/**
 * Única implementación del precio por MARGEN OBJETIVO. La usan tanto el
 * guardado autoritativo (PATCH .../catalog) como la lectura de Admin
 * (GET .../pricing, para detectar precios desactualizados): no pueden
 * calcular distinto entre sí.
 *
 * Bloquea explícitamente cuando alguna variante vendible no tiene costo
 * conocido -- calcular con el peor caso de las variantes CONOCIDAS
 * garantizaría un margen que no existe en la variante desconocida. No se
 * inventa costo, no se asume 0 y no se promedia; el precio manual sigue
 * disponible como salida.
 */
export async function resolveTargetMarginPrice({
  admin,
  productId,
  targetMarginPercent,
  eligibleInstallmentCounts,
  variantStates = null,
}: ResolveTargetMarginPriceInput): Promise<TargetMarginPriceResolution> {
  const knownCost = await resolveProductKnownCost(admin, productId)
  const relevantVariantCosts = selectRelevantVariantCosts(
    knownCost.variantCosts,
    knownCost.activeVariantIds,
    variantStates,
  )
  const basis = resolveTargetMarginCostBasis(relevantVariantCosts)

  if (!basis.ok) {
    return {
      ok: false,
      reason: basis.reason,
      message: getTargetMarginCostBasisError(basis),
      missingVariantCosts: basis.missing,
    }
  }

  const { installmentsFinancing } = await getSiteSettings({ fresh: true })
  const result = calculateTargetMarginPrice({
    cost: basis.cost,
    targetMarginPercent,
    eligibleInstallmentCounts,
    config: installmentsFinancing,
  })

  if (!result) {
    return {
      ok: false,
      reason: "unreachable_margin",
      message:
        "El margen objetivo no es alcanzable con el costo y la configuración financiera actual.",
      missingVariantCosts: [],
    }
  }

  return {
    ok: true,
    commercialPrice: result.commercialPrice,
    unitCost: basis.cost,
    relevantVariantCosts,
  }
}
