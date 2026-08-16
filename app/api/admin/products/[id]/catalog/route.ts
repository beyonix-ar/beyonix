import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  parseRequiredProductLogistics,
  ProductLogisticsValidationError,
} from "@/lib/shipping/logistics-validation"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
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

  const { data, error } = await auth.admin.rpc(
    "update_product_commercial_configuration_atomic",
    {
      p_product_id: productId,
      p_catalog: { ...body.catalog, ...logistics },
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

  return Response.json({
    product,
    variants:
      transaction && typeof transaction === "object" && "variants" in transaction
        ? transaction.variants
        : [],
  })
}
