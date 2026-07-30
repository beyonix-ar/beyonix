import { requireInternalUser } from "@/lib/auth/admin-api"

function parseId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseVariantUpdates(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const body = value as Record<string, unknown>
  const updates: Record<string, unknown> = {}

  if ("nombre" in body) {
    if (
      typeof body.nombre !== "string" ||
      !body.nombre.trim() ||
      body.nombre.trim().length > 120
    ) {
      return null
    }
    updates.nombre = body.nombre.trim()
  }
  if ("sku" in body) {
    if (body.sku !== null && typeof body.sku !== "string") return null
    updates.sku =
      typeof body.sku === "string" && body.sku.trim() ? body.sku.trim() : null
  }
  if ("color_hex" in body) {
    if (
      typeof body.color_hex !== "string" ||
      !/^#[0-9A-F]{6}$/.test(body.color_hex.trim().toUpperCase())
    ) {
      return null
    }
    updates.color_hex = body.color_hex.trim().toUpperCase()
  }
  if ("imagenes" in body) {
    if (
      !Array.isArray(body.imagenes) ||
      !body.imagenes.every(
        (image) => typeof image === "string" && Boolean(image),
      )
    ) {
      return null
    }
    updates.imagenes = body.imagenes
  }
  if ("activo" in body) {
    if (typeof body.activo !== "boolean") return null
    updates.activo = body.activo
  }
  if ("orden" in body) {
    const orden = Number(body.orden)
    if (!Number.isInteger(orden) || orden < 1) return null
    updates.orden = orden
  }

  return Object.keys(updates).length ? updates : null
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

  const updates = parseVariantUpdates(
    await request.json().catch(() => null),
  )

  if (!updates) {
    return Response.json(
      { error: "Los datos de la variante no son válidos." },
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

  if (updates.activo === true && relatedProduct?.activo === false) {
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
    .update(updates)
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

export async function DELETE(
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

  const { data: deleted, error } = await auth.admin
    .from("producto_variantes")
    .delete()
    .eq("id", variantId)
    .eq("producto_id", productId)
    .select("id")
    .maybeSingle()

  if (error) {
    return Response.json(
      {
        error:
          error.code === "23503"
            ? "La variante tiene movimientos asociados y no se puede eliminar."
            : error.message || "No se pudo eliminar la variante.",
      },
      { status: error.code === "23503" ? 409 : 500 },
    )
  }
  if (!deleted) {
    return Response.json(
      { error: "La variante ya no existe." },
      { status: 404 },
    )
  }

  return Response.json({ success: true })
}
