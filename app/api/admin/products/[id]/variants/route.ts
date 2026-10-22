import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  VARIANT_CREATION_RULE_CODE,
  VARIANT_CREATION_RULE_MESSAGE,
  purchaseUrlForProduct,
} from "@/lib/products/variant-creation-rule"

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const productId = positiveInteger((await context.params).id)
  if (!productId) {
    return Response.json(
      { error: "El producto indicado no es válido." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin
    .from("producto_variantes")
    .select("*")
    .eq("producto_id", productId)
    .order("orden", { ascending: true })
    .order("id", { ascending: true })

  if (error) {
    return Response.json(
      { error: "No se pudieron cargar las variantes del producto." },
      { status: 500 },
    )
  }

  return Response.json({ variants: data ?? [] })
}

// Alta libre de variantes deshabilitada: una variante física nueva nace de una
// compra / ingreso de mercadería (ver lib/products/variant-creation-rule.ts).
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = positiveInteger((await context.params).id)
  return Response.json(
    {
      error: VARIANT_CREATION_RULE_MESSAGE,
      code: VARIANT_CREATION_RULE_CODE,
      purchaseUrl: purchaseUrlForProduct(productId),
    },
    { status: 409 },
  )
}
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = positiveInteger((await context.params).id)
  const body = (await request.json().catch(() => null)) as
    | { variantIds?: unknown }
    | null
  const variantIds = Array.isArray(body?.variantIds)
    ? body.variantIds.map(Number)
    : null

  if (
    !productId ||
    !variantIds ||
    variantIds.some((id) => !Number.isInteger(id) || id <= 0)
  ) {
    return Response.json(
      { error: "El orden de variantes no es válido." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin.rpc(
    "reorder_product_variants_atomic",
    {
      p_product_id: productId,
      p_variant_ids: variantIds,
      p_actor_id: auth.user.id,
    },
  )

  if (error) {
    const missingMigration =
      /reorder_product_variants_atomic|schema cache|PGRST202/i.test(error.message)
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260808120000_atomic_product_catalog_workflow.sql."
          : error.message || "No se pudo reordenar las variantes.",
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  return Response.json({ variants: data ?? [] })
}
