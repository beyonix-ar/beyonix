import { requireInternalUser } from "@/lib/auth/admin-api"
import { resolveProductKnownCost } from "@/lib/admin/product-known-cost"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Lectura, exclusiva de Admin, del costo conocido y el método de precio
 * configurado para un producto -- nunca se expone fuera de rutas admin/*.
 * El costo se resuelve por variante (un producto con variantes nunca se
 * compra "a nivel producto"): `knownUnitCost` es el peor caso entre las
 * variantes conocidas (ver resolveProductKnownCost), y `variantCosts` es el
 * detalle completo para que la UI muestre diferencias reales entre
 * variantes en vez de ocultarlas detrás de un único número.
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

  return Response.json({
    knownUnitCost: knownCost.knownUnitCost,
    variantCosts: knownCost.variantCosts,
    pricingMode: pricingResult.data?.pricing_mode === "target_margin" ? "target_margin" : "manual",
    targetMarginPercent: pricingResult.data?.target_margin_percent ?? null,
  })
}
