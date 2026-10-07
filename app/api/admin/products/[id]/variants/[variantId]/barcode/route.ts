import { requireInternalUser } from "@/lib/auth/admin-api"

function parseId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

// "Generar código BEYONIX": idempotente en la base. Si la variante ya tiene
// un código (fabricante o BEYONIX) lo devuelve sin modificarlo.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error
  const params = await context.params
  const productId = parseId(params.id)
  const variantId = parseId(params.variantId)
  if (!productId || !variantId) {
    return Response.json({ error: "La variante indicada no es válida." }, { status: 400 })
  }
  const { data, error } = await auth.admin.rpc("generate_beyonix_variant_barcode", {
    p_product_id: productId,
    p_variant_id: variantId,
    p_actor_id: auth.user.id,
  })
  if (error) {
    const missingMigration = /generate_beyonix_variant_barcode|schema cache|PGRST202/i.test(error.message)
    return Response.json(
      { error: missingMigration ? "Falta aplicar la migración 20261007100000_barcodes_parcels_dispatch.sql." : error.message || "No se pudo generar el código." },
      { status: missingMigration ? 503 : 409 },
    )
  }
  const variant = Array.isArray(data) ? data[0] : data
  if (!variant) return Response.json({ error: "La variante ya no existe." }, { status: 404 })
  return Response.json({ variant })
}
