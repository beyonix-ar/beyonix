import { requireInternalUser } from "@/lib/auth/admin-api"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseVariantPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const body = value as Record<string, unknown>
  const nombre = typeof body.nombre === "string" ? body.nombre.trim() : ""
  const sku =
    body.sku === null || body.sku === undefined || body.sku === ""
      ? null
      : typeof body.sku === "string"
        ? body.sku.trim()
        : null
  const colorHex =
    typeof body.color_hex === "string" ? body.color_hex.trim().toUpperCase() : ""
  const imagenes = Array.isArray(body.imagenes)
    ? body.imagenes.filter(
        (image): image is string => typeof image === "string" && Boolean(image),
      )
    : []
  const activo = typeof body.activo === "boolean" ? body.activo : true
  const orden = Number(body.orden)

  if (
    !nombre ||
    nombre.length > 120 ||
    (body.sku !== null &&
      body.sku !== undefined &&
      body.sku !== "" &&
      typeof body.sku !== "string") ||
    !/^#[0-9A-F]{6}$/.test(colorHex) ||
    !Number.isInteger(orden) ||
    orden < 1 ||
    imagenes.length !== (Array.isArray(body.imagenes) ? body.imagenes.length : 0)
  ) {
    return null
  }

  return {
    nombre,
    sku,
    color_hex: colorHex,
    imagenes,
    activo,
    orden,
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  if (!productId) {
    return Response.json(
      { error: "El producto indicado no es válido." },
      { status: 400 },
    )
  }

  const { data: variants, error } = await auth.admin
    .from("producto_variantes")
    .select("*")
    .eq("producto_id", productId)
    .order("orden", { ascending: true })
    .order("id", { ascending: true })

  if (error) {
    return Response.json(
      { error: error.message || "No se pudieron cargar las variantes." },
      { status: 500 },
    )
  }

  return Response.json({ variants: variants ?? [] })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  const payload = parseVariantPayload(await request.json().catch(() => null))

  if (!productId || !payload) {
    return Response.json(
      { error: "Los datos de la variante no son válidos." },
      { status: 400 },
    )
  }

  const { data: product, error: productError } = await auth.admin
    .from("productos")
    .select("id")
    .eq("id", productId)
    .maybeSingle()

  if (productError) {
    return Response.json(
      { error: "No se pudo comprobar el producto." },
      { status: 500 },
    )
  }
  if (!product) {
    return Response.json(
      { error: "El producto ya no existe." },
      { status: 404 },
    )
  }

  const { data: variant, error } = await auth.admin
    .from("producto_variantes")
    .insert({
      producto_id: productId,
      ...payload,
    })
    .select("*")
    .single()

  if (error) {
    const duplicatedSku = error.code === "23505"
    return Response.json(
      {
        error: duplicatedSku
          ? "El SKU ingresado ya pertenece a otra variante."
          : error.message || "No se pudo crear la variante.",
      },
      { status: duplicatedSku ? 409 : 500 },
    )
  }

  const { error: productSkuError } = await auth.admin
    .from("productos")
    .update({ sku: null })
    .eq("id", productId)

  if (productSkuError) {
    await auth.admin
      .from("producto_variantes")
      .delete()
      .eq("id", variant.id)

    return Response.json(
      {
        error:
          "No se pudo trasladar el SKU general a la variante. Intentá nuevamente.",
      },
      { status: 500 },
    )
  }

  return Response.json({ variant }, { status: 201 })
}
