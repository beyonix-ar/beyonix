import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  FeaturedUpdateInputError,
  mapFeaturedRpcError,
  parseFeaturedUpdateInput,
} from "@/lib/products/featured-products"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

interface FeaturedRpcResult {
  destacado?: unknown
  featured_position?: unknown
  catalog_revision?: unknown
}

/**
 * Destacar, cambiar la posición o quitar el destacado de un producto en una
 * sola operación atómica (`set_product_featured_position`). La base rechaza
 * una posición ocupada y limpia la posición al quitar el destacado; acá sólo
 * se valida la entrada y se traduce el error a un mensaje para Admin.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = parseProductId((await context.params).id)
  if (!productId) {
    return Response.json({ error: "Producto inválido." }, { status: 400 })
  }

  let update
  try {
    update = parseFeaturedUpdateInput(await request.json().catch(() => null))
  } catch (inputError) {
    return Response.json(
      {
        error:
          inputError instanceof FeaturedUpdateInputError
            ? inputError.message
            : "Los datos del destacado no son válidos.",
      },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin.rpc("set_product_featured_position", {
    p_product_id: productId,
    p_destacado: update.destacado,
    p_position: update.featuredPosition,
    p_expected_revision: update.expectedRevision,
  })

  if (error) {
    const mapped = mapFeaturedRpcError(error)
    if (mapped.status === 500) {
      console.error("PRODUCT_FEATURED_UPDATE_ERROR", { productId, code: error.code })
    }
    return Response.json(
      { error: mapped.error, ...("code" in mapped ? { code: mapped.code } : {}) },
      { status: mapped.status },
    )
  }

  const result = (data ?? {}) as FeaturedRpcResult
  if (typeof result.destacado !== "boolean" || typeof result.catalog_revision !== "number") {
    return Response.json(
      { error: "El destacado se actualizó sin una respuesta verificable." },
      { status: 500 },
    )
  }

  return Response.json({
    destacado: result.destacado,
    featuredPosition:
      typeof result.featured_position === "number" ? result.featured_position : null,
    catalogRevision: result.catalog_revision,
  })
}
