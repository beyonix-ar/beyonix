import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  parseRequiredProductLogistics,
  ProductLogisticsValidationError,
} from "@/lib/shipping/logistics-validation"
import { resolveProductKnownCost } from "@/lib/admin/product-known-cost"
import { calculateTargetMarginPrice } from "@/lib/pricing/product-pricing"
import { getSiteSettings } from "@/lib/site-settings"
import type { InstallmentCount } from "@/lib/products/installments"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parsePricingMode(value: unknown): "manual" | "target_margin" {
  return value === "target_margin" ? "target_margin" : "manual"
}

function parseTargetMarginPercent(value: unknown): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 100 ? parsed : null
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  const body = (await request.json().catch(() => null)) as
    | { catalog?: unknown; primarySku?: unknown; variantStates?: unknown }
    | null
  const variantStates = Array.isArray(body?.variantStates)
    ? body.variantStates
    : null
  const validVariantStates =
    variantStates != null &&
    variantStates.every(
      (state) =>
        state != null &&
        typeof state === "object" &&
        !Array.isArray(state) &&
        Number.isInteger((state as { id?: unknown }).id) &&
        Number((state as { id?: unknown }).id) > 0 &&
        typeof (state as { active?: unknown }).active === "boolean",
    )
  const variantIds = validVariantStates
    ? variantStates.map((state) => Number((state as { id: number }).id))
    : []

  if (
    !productId ||
    !body?.catalog ||
    typeof body.catalog !== "object" ||
    Array.isArray(body.catalog) ||
    (body.primarySku != null && typeof body.primarySku !== "string") ||
    !validVariantStates ||
    new Set(variantIds).size !== variantIds.length
  ) {
    return Response.json(
      { error: "Los datos comerciales del producto no son válidos." },
      { status: 400 },
    )
  }

  let logistics
  try {
    logistics = parseRequiredProductLogistics(
      body.catalog as Record<string, unknown>,
    )
  } catch (validationError) {
    return Response.json(
      {
        error:
          validationError instanceof ProductLogisticsValidationError
            ? validationError.message
            : "El peso y las dimensiones del producto son obligatorios.",
      },
      { status: 400 },
    )
  }

  // pricing_mode/target_margin_percent no son columnas de `productos`: viven
  // en product_pricing (tabla separada, admin-only). Se sacan del catalog
  // antes de mandarlo a la RPC y se procesan/persisten acá mismo.
  const catalogInput = { ...(body.catalog as Record<string, unknown>) }
  const pricingMode = parsePricingMode(catalogInput.pricing_mode)
  const targetMarginPercent = parseTargetMarginPercent(catalogInput.target_margin_percent)
  delete catalogInput.pricing_mode
  delete catalogInput.target_margin_percent

  if (pricingMode === "target_margin") {
    if (targetMarginPercent == null) {
      return Response.json(
        { error: "El margen objetivo no es válido." },
        { status: 400 },
      )
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
    const knownUnitCost = knownCost.knownUnitCost

    if (knownUnitCost == null) {
      return Response.json(
        {
          error:
            "Costo desconocido: cargá un costo de compra para este producto en Admin > Costos antes de usar margen objetivo.",
        },
        { status: 400 },
      )
    }

    const { installmentsFinancing } = await getSiteSettings({ fresh: true })
    const eligibleInstallmentCounts: InstallmentCount[] = [
      ...(catalogInput.cuotas_2_habilitadas ? [2 as const] : []),
      ...(catalogInput.cuotas_3_habilitadas ? [3 as const] : []),
      ...(catalogInput.cuotas_6_habilitadas ? [6 as const] : []),
    ]

    const targetMarginResult = calculateTargetMarginPrice({
      cost: knownUnitCost,
      targetMarginPercent,
      eligibleInstallmentCounts,
      config: installmentsFinancing,
    })

    if (!targetMarginResult) {
      return Response.json(
        {
          error:
            "El margen objetivo no es alcanzable con el costo y la configuración financiera actual.",
        },
        { status: 400 },
      )
    }

    // Autoritativo: el precio que haya mandado el navegador se ignora y se
    // sobreescribe acá, igual que ya se hace con la logística.
    catalogInput.precio = targetMarginResult.commercialPrice
  }

  const { data, error } = await auth.admin.rpc(
    "update_product_commercial_configuration_atomic",
    {
      p_product_id: productId,
      p_catalog: { ...catalogInput, ...logistics },
      p_primary_sku: body.primarySku ?? null,
      p_variant_states: variantStates,
      p_actor_id: auth.user.id,
    },
  )

  if (error) {
    const missingMigration =
      /update_product_commercial_configuration_atomic|schema cache|PGRST202/i.test(
        error.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260808220000_atomic_product_variant_commercial_save.sql."
          : error.message || "No se pudo actualizar el producto.",
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  const transaction = Array.isArray(data) ? data[0] : data
  const product =
    transaction && typeof transaction === "object" && "product" in transaction
      ? transaction.product
      : null
  if (!product) {
    return Response.json(
      { error: "El producto se actualizó sin una respuesta verificable." },
      { status: 500 },
    )
  }

  // Escritura secundaria de metadata (método de precio), después de que el
  // catálogo ya quedó confirmado por la RPC atómica -- el precio en sí ya es
  // autoritativo en este punto, esto sólo registra cómo se llegó a él.
  await auth.admin.from("product_pricing").upsert({
    product_id: productId,
    pricing_mode: pricingMode,
    target_margin_percent: pricingMode === "target_margin" ? targetMarginPercent : null,
    updated_at: new Date().toISOString(),
    updated_by: auth.user.id,
  })

  return Response.json({
    product,
    variants:
      transaction && typeof transaction === "object" && "variants" in transaction
        ? transaction.variants
        : [],
  })
}
