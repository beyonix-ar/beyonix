import { requireInternalUser } from "@/lib/auth/admin-api"

function parseId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const params = await context.params
  const productId = parseId(params.id)
  const variantId = parseId(params.variantId)

  if (!productId || !variantId) {
    return Response.json(
      { error: "La variante indicada no es válida." },
      { status: 400 },
    )
  }

  const body = (await request.json().catch(() => null)) as {
    activo?: unknown
  } | null

  if (typeof body?.activo !== "boolean") {
    return Response.json(
      { error: "El estado de la variante no es válido." },
      { status: 400 },
    )
  }

  const { data: variant, error: variantError } = await auth.admin
    .from("producto_variantes")
    .select("id, producto_id, productos(activo)")
    .eq("id", variantId)
    .eq("producto_id", productId)
    .maybeSingle()

  if (variantError) {
    return Response.json(
      { error: "No se pudo consultar la variante." },
      { status: 500 },
    )
  }

  if (!variant) {
    return Response.json(
      { error: "La variante ya no existe." },
      { status: 404 },
    )
  }

  const relatedProduct = Array.isArray(variant.productos)
    ? variant.productos[0]
    : variant.productos

  if (body.activo && relatedProduct?.activo === false) {
    return Response.json(
      {
        error:
          "Activá primero el producto principal para habilitar esta variante.",
      },
      { status: 409 },
    )
  }

  const { data: updated, error: updateError } = await auth.admin
    .from("producto_variantes")
    .update({ activo: body.activo })
    .eq("id", variantId)
    .eq("producto_id", productId)
    .select("*")
    .single()

  if (updateError) {
    return Response.json(
      {
        error:
          updateError.message || "No se pudo cambiar el estado de la variante.",
      },
      { status: 500 },
    )
  }

  return Response.json({ variant: updated })
}
