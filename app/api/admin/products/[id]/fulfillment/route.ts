import { requireInternalUser } from "@/lib/auth/admin-api"
import { isProductColorMode, type ProductColorMode } from "@/lib/products/color-mode"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

// Venta por color (lib/products/color-mode.ts): color específico, aleatorio
// simple (un artículo, stock total) o aleatorio con variantes físicas. Acepta
// el campo legacy `ventaAleatoria` (true = con variantes físicas).
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  const body = (await request.json().catch(() => null)) as { colorMode?: unknown; ventaAleatoria?: unknown } | null
  const mode: ProductColorMode | null = isProductColorMode(body?.colorMode)
    ? body.colorMode
    : typeof body?.ventaAleatoria === "boolean"
      ? body.ventaAleatoria ? "aleatorio_variantes" : "especifico"
      : null
  if (!productId || !mode) {
    return Response.json({ error: "Los datos de venta por color no son válidos." }, { status: 400 })
  }

  const { data, error } = await auth.admin.rpc("set_product_color_mode", {
    p_product_id: productId,
    p_mode: mode,
    p_actor_id: auth.user.id,
  })

  if (error) {
    if (/RANDOM_FULFILLMENT_NEEDS_VARIANTS/.test(error.message)) {
      return Response.json(
        { error: "La venta aleatoria con variantes físicas necesita al menos dos variantes del producto." },
        { status: 409 },
      )
    }
    if (/RANDOM_SIMPLE_SINGLE_VARIANT/.test(error.message)) {
      return Response.json(
        { error: "El aleatorio sin seguimiento de color es un único artículo: dejá una sola variante (con el stock total) o usá “con variantes físicas”." },
        { status: 409 },
      )
    }
    if (/set_product_color_mode|schema cache|PGRST202/i.test(error.message)) {
      return Response.json(
        { error: "Falta aplicar la migración 20261010100000_random_simple_color_mode.sql." },
        { status: 503 },
      )
    }
    if (/ya no existe/.test(error.message)) {
      return Response.json({ error: "El producto ya no existe." }, { status: 404 })
    }
    return Response.json({ error: "No se pudo actualizar la venta por color." }, { status: 500 })
  }

  const product = (Array.isArray(data) ? data[0] : data) as { venta_aleatoria?: unknown; modo_color?: unknown } | null
  const colorMode = isProductColorMode(product?.modo_color) ? product.modo_color : mode
  return Response.json({ colorMode, ventaAleatoria: product?.venta_aleatoria === true })
}
