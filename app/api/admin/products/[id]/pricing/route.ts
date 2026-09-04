import { requireInternalUser } from "@/lib/auth/admin-api"
import type { createAdminClient } from "@/lib/supabase/admin"
import { resolveProductKnownCost } from "@/lib/admin/product-known-cost"
import {
  resolveTargetMarginPrice,
  selectRelevantVariantCosts,
} from "@/lib/pricing/product-target-margin"
import { getEligibleInstallmentCounts } from "@/lib/products/installments"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

interface ProductPricingProductRow {
  precio: number | null
  cuotas_2_habilitadas: boolean | null
  cuotas_3_habilitadas: boolean | null
  cuotas_6_habilitadas: boolean | null
}

/**
 * Lectura, exclusiva de Admin, del costo conocido y el método de precio
 * configurado para un producto -- nunca se expone fuera de rutas admin/*.
 * El costo se resuelve por variante (un producto con variantes nunca se
 * compra "a nivel producto"): `knownUnitCost` es el peor caso entre las
 * variantes conocidas (ver resolveProductKnownCost), y `variantCosts` es el
 * detalle completo para que la UI muestre diferencias reales entre
 * variantes en vez de ocultarlas detrás de un único número.
 *
 * Para productos en MARGEN OBJETIVO además se recalcula el precio con los
 * insumos ACTUALES (costo recibido + tarifas de Mercado Pago vigentes) y se
 * compara contra `productos.precio`. Es detección explícita, no recálculo
 * automático: si cambian las tarifas de MP o se carga un costo nuevo, el
 * producto queda marcado como desactualizado en vez de seguir usando un
 * precio viejo en silencio. Se calcula al leer, así que nunca puede quedar
 * una marca obsoleta guardada en base.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  if (!productId) {
    return Response.json({ error: "Producto inválido." }, { status: 400 })
  }

  let knownCost
  try {
    knownCost = await resolveProductKnownCost(auth.admin, productId)
  } catch {
    return Response.json(
      { error: "No se pudo consultar el costo del producto." },
      { status: 500 },
    )
  }

  const pricingResult = await auth.admin
    .from("product_pricing")
    .select("pricing_mode, target_margin_percent")
    .eq("product_id", productId)
    .maybeSingle()

  if (pricingResult.error) {
    const missingMigration = /product_pricing|schema cache|PGRST205/i.test(
      pricingResult.error.message,
    )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260828120000_create_product_pricing.sql en Supabase."
          : "No se pudo consultar el método de precio del producto.",
      },
      { status: missingMigration ? 503 : 500 },
    )
  }

  const pricingMode =
    pricingResult.data?.pricing_mode === "target_margin"
      ? ("target_margin" as const)
      : ("manual" as const)
  const targetMarginPercent = pricingResult.data?.target_margin_percent ?? null
  const relevantVariantCosts = selectRelevantVariantCosts(
    knownCost.variantCosts,
    knownCost.activeVariantIds,
    null,
  )
  const missingVariantCosts = relevantVariantCosts.filter(
    (entry) => entry.unitCost == null,
  )

  const recalculation = await resolveTargetMarginRecalculation({
    admin: auth.admin,
    productId,
    pricingMode,
    targetMarginPercent,
  })

  return Response.json({
    knownUnitCost: knownCost.knownUnitCost,
    variantCosts: knownCost.variantCosts,
    /** Variantes vendibles sin costo cargado: bloquean el margen objetivo. */
    missingVariantCosts,
    pricingMode,
    targetMarginPercent,
    ...recalculation,
  })
}

async function resolveTargetMarginRecalculation({
  admin,
  productId,
  pricingMode,
  targetMarginPercent,
}: {
  admin: ReturnType<typeof createAdminClient>
  productId: number
  pricingMode: "manual" | "target_margin"
  targetMarginPercent: number | null
}) {
  const empty = {
    requiresRecalculation: false,
    recalculatedPrice: null as number | null,
    recalculationBlockedReason: null as string | null,
  }

  if (pricingMode !== "target_margin" || targetMarginPercent == null) {
    return empty
  }

  const productResult = await admin
    .from("productos")
    .select(
      "precio, cuotas_2_habilitadas, cuotas_3_habilitadas, cuotas_6_habilitadas",
    )
    .eq("id", productId)
    .maybeSingle()

  if (productResult.error || !productResult.data) return empty

  const product = productResult.data as ProductPricingProductRow
  const resolution = await resolveTargetMarginPrice({
    admin,
    productId,
    targetMarginPercent,
    eligibleInstallmentCounts: getEligibleInstallmentCounts({
      cuotas_2_habilitadas: product.cuotas_2_habilitadas ?? false,
      cuotas_3_habilitadas: product.cuotas_3_habilitadas ?? false,
      cuotas_6_habilitadas: product.cuotas_6_habilitadas ?? false,
    }),
  })

  if (!resolution.ok) {
    return {
      requiresRecalculation: true,
      recalculatedPrice: null,
      recalculationBlockedReason: resolution.message,
    }
  }

  const currentPrice = Number(product.precio ?? 0)

  return {
    requiresRecalculation:
      Math.abs(currentPrice - resolution.commercialPrice) > 0.009,
    recalculatedPrice: resolution.commercialPrice,
    recalculationBlockedReason: null,
  }
}
