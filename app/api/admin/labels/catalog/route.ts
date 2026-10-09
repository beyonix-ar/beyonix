import { requireInternalUser } from "@/lib/auth/admin-api"
import { MAX_CATALOG_SEARCH_LENGTH } from "@/lib/business/cost-catalog-search"
import { LABEL_ROLES } from "@/lib/labels/api-roles"
import { MAX_LABEL_CATALOG_IDS, loadLabelProductsByIds, searchLabelCatalog } from "@/lib/labels/label-catalog-server"

const MAX_OFFSET = 100_000

// Etiquetas: búsqueda paginada del catálogo (`q`, `offset`) o revalidación de
// artículos puntuales de la cola (`ids=1,2,3`). Solo lectura.
export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...LABEL_ROLES])
  if ("error" in auth) return auth.error
  const params = new URL(request.url).searchParams
  const headers = { "Cache-Control": "no-store" }
  const idsParam = params.get("ids")
  const query = params.get("q")?.trim() ?? ""
  const offset = Number(params.get("offset") ?? 0)
  const ids = idsParam == null ? null : idsParam.split(",").map(Number)
  if (
    (ids && (!ids.length || ids.length > MAX_LABEL_CATALOG_IDS || !ids.every((id) => Number.isSafeInteger(id) && id > 0))) ||
    query.length > MAX_CATALOG_SEARCH_LENGTH ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > MAX_OFFSET
  ) {
    return Response.json({ error: "Búsqueda inválida." }, { status: 400, headers })
  }
  try {
    if (ids) return Response.json({ items: await loadLabelProductsByIds(auth.admin, ids), hasMore: false }, { headers })
    return Response.json(await searchLabelCatalog(auth.admin, query, offset), { headers })
  } catch {
    return Response.json({ error: "No se pudieron cargar los artículos." }, { status: 500, headers })
  }
}
