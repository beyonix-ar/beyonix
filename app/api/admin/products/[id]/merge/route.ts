import { requireInternalUser } from "@/lib/auth/admin-api"

function parseProductId(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["super_admin"])
  if ("error" in auth) return auth.error

  const { id: rawId } = await context.params
  const keepProductId = parseProductId(rawId)
  const body = (await request.json().catch(() => null)) as
    | { absorbProductId?: unknown }
    | null
  const absorbProductId = parseProductId(body?.absorbProductId)

  if (!keepProductId || !absorbProductId) {
    return Response.json(
      { error: "Los productos a fusionar no son válidos." },
      { status: 400 },
    )
  }
  if (keepProductId === absorbProductId) {
    return Response.json(
      { error: "No podés fusionar un producto consigo mismo." },
      { status: 400 },
    )
  }

  const { data: mergeResult, error } = await auth.admin.rpc(
    "merge_catalog_products",
    {
      p_keep_product_id: keepProductId,
      p_absorb_product_id: absorbProductId,
      p_actor_id: auth.user.id,
    },
  )

  if (error) {
    const missingMigration =
      /merge_catalog_products|schema cache|PGRST202/i.test(error.message)
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260820150000_merge_catalog_products.sql."
          : error.message || "No se pudieron fusionar los productos.",
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  const product = Array.isArray(mergeResult) ? mergeResult[0] : mergeResult
  if (!product) {
    return Response.json(
      { error: "La fusión se completó sin una respuesta verificable." },
      { status: 500 },
    )
  }

  return Response.json({ product })
}
