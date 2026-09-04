import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  parseRequiredProductLogistics,
  ProductLogisticsValidationError,
} from "@/lib/shipping/logistics-validation"
import {
  resolveTargetMarginPrice,
  type TargetMarginVariantState,
} from "@/lib/pricing/product-target-margin"
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

    const eligibleInstallmentCounts: InstallmentCount[] = [
      ...(catalogInput.cuotas_2_habilitadas ? [2 as const] : []),
      ...(catalogInput.cuotas_3_habilitadas ? [3 as const] : []),
      ...(catalogInput.cuotas_6_habilitadas ? [6 as const] : []),
    ]

    let targetMarginResult
    try {
      targetMarginResult = await resolveTargetMarginPrice({
        admin: auth.admin,
        productId,
        targetMarginPercent,
        eligibleInstallmentCounts,
        variantStates: variantStates as TargetMarginVariantState[],
      })
    } catch {
      return Response.json(
        { error: "No se pudo consultar el costo del producto." },
        { status: 500 },
      )
    }

    // Se bloquea el cálculo automático (no se degrada silenciosamente a las
    // variantes con costo conocido) cuando falta el costo de alguna variante
    // vendible: el margen resultante no sería el prometido en esa variante.
    if (!targetMarginResult.ok) {
      return Response.json(
        {
          error: targetMarginResult.message,
          missingVariantCosts: targetMarginResult.missingVariantCosts,
        },
        { status: 400 },
      )
    }

    // Autoritativo: el precio que haya mandado el navegador se ignora y se
    // sobreescribe acá, igual que ya se hace con la logística.
    catalogInput.precio = targetMarginResult.commercialPrice
  }

  const resolvedTargetMarginPercent =
    pricingMode === "target_margin" ? targetMarginPercent : null

  // Precio público y método de precio se persisten en UNA sola transacción:
  // un producto no puede quedar con `productos.precio` recalculado por margen
  // objetivo y `product_pricing` en manual (o al revés). Mientras la
  // migración nueva no esté aplicada se cae al camino anterior de dos
  // escrituras -- es el comportamiento que ya existía, no una regresión.
  let { data, error } = await auth.admin.rpc(
    "update_product_commercial_configuration_with_pricing_atomic",
    {
      p_product_id: productId,
      p_catalog: { ...catalogInput, ...logistics },
      p_primary_sku: body.primarySku ?? null,
      p_variant_states: variantStates,
      p_actor_id: auth.user.id,
      p_pricing_mode: pricingMode,
      p_target_margin_percent: resolvedTargetMarginPercent,
    },
  )
  let pricingPersistedAtomically = true

  if (
    error &&
    /update_product_commercial_configuration_with_pricing_atomic|PGRST202|42883/i.test(
      `${error.code ?? ""} ${error.message}`,
    )
  ) {
    pricingPersistedAtomically = false
    ;({ data, error } = await auth.admin.rpc(
      "update_product_commercial_configuration_atomic",
      {
        p_product_id: productId,
        p_catalog: { ...catalogInput, ...logistics },
        p_primary_sku: body.primarySku ?? null,
        p_variant_states: variantStates,
        p_actor_id: auth.user.id,
      },
    ))
  }

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

  if (!pricingPersistedAtomically) {
    // Camino de compatibilidad (migración de guardado atómico todavía sin
    // aplicar): escritura secundaria de la metadata de precio.
    const { error: pricingError } = await auth.admin
      .from("product_pricing")
      .upsert({
        product_id: productId,
        pricing_mode: pricingMode,
        target_margin_percent: resolvedTargetMarginPercent,
        updated_at: new Date().toISOString(),
        updated_by: auth.user.id,
      })

    if (pricingError) {
      // El precio ya quedó guardado; avisar en vez de devolver un OK que
      // oculta que el método de precio quedó desincronizado.
      return Response.json(
        {
          product,
          error:
            "El precio se guardó, pero no se pudo registrar el método de precio. Volvé a guardar el producto.",
        },
        { status: 500 },
      )
    }
  }

  return Response.json({
    product,
    variants:
      transaction && typeof transaction === "object" && "variants" in transaction
        ? transaction.variants
        : [],
  })
}
