import { requireInternalUser } from "@/lib/auth/admin-api"
import { MAX_SCAN_CODE_LENGTH, findCatalogArticleByCode } from "@/lib/barcodes/catalog-lookup"
import { createSupabaseCatalogCodeStore } from "@/lib/barcodes/catalog-lookup-store"
import { isReservedProductBarcode } from "@/lib/barcodes/codes"

// Escaneo de Compras: identidad del artículo (producto, variante, SKU, color y
// código) por código de barra o SKU exactos. Solo lectura.
export async function GET(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error
  const code = new URL(request.url).searchParams.get("code")?.trim() ?? ""
  if (!code || code.length > MAX_SCAN_CODE_LENGTH) {
    return Response.json({ error: "Ingresá un código válido." }, { status: 400 })
  }
  const headers = { "Cache-Control": "no-store" }
  if (isReservedProductBarcode(code)) return Response.json({ match: null }, { headers })
  try {
    const match = await findCatalogArticleByCode(createSupabaseCatalogCodeStore(auth.admin), code)
    return Response.json({ match }, { headers })
  } catch (error) {
    return Response.json(
      { error: error instanceof Error && /CATALOG_CODE_AMBIGUOUS/.test(error.message)
        ? "Este código está asociado a más de un artículo. Corregí el catálogo antes de escanearlo."
        : "No se pudo buscar el código." },
      { status: 500, headers },
    )
  }
}
