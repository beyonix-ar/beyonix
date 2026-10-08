import { requireInternalUser } from "@/lib/auth/admin-api"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

// Venta con color/modelo aleatorio. El stock sigue siendo por variante física:
// este flag sólo cambia cómo se vende (el cliente no elige color).
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  const body = (await request.json().catch(() => null)) as { ventaAleatoria?: unknown } | null
  if (!productId || typeof body?.ventaAleatoria !== "boolean") {
    return Response.json({ error: "Los datos de venta aleatoria no son válidos." }, { status: 400 })
  }

  const { data, error } = await auth.admin.rpc("set_product_random_fulfillment", {
    p_product_id: productId,
    p_enabled: body.ventaAleatoria,
    p_actor_id: auth.user.id,
  })

  if (error) {
    if (/RANDOM_FULFILLMENT_NEEDS_VARIANTS/.test(error.message)) {
      return Response.json(
        { error: "La venta aleatoria necesita al menos dos variantes del producto." },
        { status: 409 },
      )
    }
    if (/set_product_random_fulfillment|schema cache|PGRST202/i.test(error.message)) {
      return Response.json(
        { error: "Falta aplicar la migración 20261008120000_catalog_random_dual_color_barcode_aliases.sql." },
        { status: 503 },
      )
    }
    if (/ya no existe/.test(error.message)) {
      return Response.json({ error: "El producto ya no existe." }, { status: 404 })
    }
    return Response.json({ error: "No se pudo actualizar la venta aleatoria." }, { status: 500 })
  }

  const product = Array.isArray(data) ? data[0] : data
  return Response.json({ ventaAleatoria: product?.venta_aleatoria === true })
}
