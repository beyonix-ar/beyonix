import { requireInternalUser } from "@/lib/auth/admin-api"
import { MAX_CATALOG_SEARCH_LENGTH } from "@/lib/business/cost-catalog-search"
import { loadCatalogProductsByIds, searchCostCatalog } from "@/lib/business/cost-catalog-server"

const MAX_OFFSET = 100_000

// Selector manual de Compras/Gastos: búsqueda paginada del catálogo, o un
// artículo puntual por id (`productId`). Solo lectura.
export async function GET(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error
  const params = new URL(request.url).searchParams
  const headers = { "Cache-Control": "no-store" }
  const productIdParam = params.get("productId")
  const productId = productIdParam == null ? null : Number(productIdParam)
  const query = params.get("q")?.trim() ?? ""
  const offset = Number(params.get("offset") ?? 0)
  if (
    (productId != null && !(Number.isSafeInteger(productId) && productId > 0)) ||
    query.length > MAX_CATALOG_SEARCH_LENGTH ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_OFFSET
  ) {
    return Response.json({ error: "Búsqueda inválida." }, { status: 400, headers })
  }
  try {
    if (productId != null) {
      return Response.json(
        { items: await loadCatalogProductsByIds(auth.admin, [productId]), hasMore: false },
        { headers },
      )
    }
    return Response.json(await searchCostCatalog(auth.admin, query, offset), { headers })
  } catch {
    return Response.json({ error: "No se pudieron cargar los artículos." }, { status: 500, headers })
  }
}
