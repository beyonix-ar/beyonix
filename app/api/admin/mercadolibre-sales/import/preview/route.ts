import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  describeMercadoLibreImportError,
  isMissingImportMigration,
  validateMercadoLibreServerRows,
  type MercadoLibrePreviewStatus,
} from "@/lib/mercadolibre/import-validation"
import type { MercadoLibreProductMatch } from "@/lib/mercadolibre/product-matching"
import {
  MercadoLibreMatchingLoadError,
  loadMercadoLibreMatchingData,
  resolveMercadoLibreServerRow,
} from "@/lib/mercadolibre/product-matching-server"

function errorResponse(message: string, fallback: string) {
  console.error("ML_IMPORT_PREVIEW_ERROR", message)
  return Response.json(
    { error: describeMercadoLibreImportError(message, fallback) },
    { status: isMissingImportMigration(message) ? 503 : 500 },
  )
}

/**
 * Compara un bloque del archivo contra lo ya cargado, sin escribir nada:
 * cuántas ventas son nuevas, cuáles ya existen, si el archivo las cambiaría
 * y con qué producto/variante se vincularía cada línea.
 */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  let body: { rows?: unknown; fileSha256?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: "El archivo llegó incompleto. Volvé a analizarlo." }, { status: 400 })
  }

  const validation = validateMercadoLibreServerRows(body.rows)
  if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 })

  const fileSha256 = typeof body.fileSha256 === "string" && /^[0-9a-f]{64}$/.test(body.fileSha256) ? body.fileSha256 : null

  let matchingData: Awaited<ReturnType<typeof loadMercadoLibreMatchingData>>
  try {
    matchingData = await loadMercadoLibreMatchingData(auth.admin, validation.rows)
  } catch (error) {
    return errorResponse(
      error instanceof MercadoLibreMatchingLoadError ? error.detail : String(error),
      error instanceof MercadoLibreMatchingLoadError ? error.message : "No se pudo vincular el catálogo.",
    )
  }

  const [previewResult, previousResult] = await Promise.all([
    auth.admin.rpc("preview_mercadolibre_import", { p_rows: validation.rows }),
    fileSha256
      ? auth.admin
          .from("mercadolibre_import_batches")
          .select("id, created_at, source_file_name, status")
          .eq("file_sha256", fileSha256)
          .in("status", ["completed", "partially_reverted"])
          .order("created_at", { ascending: false })
          .limit(1)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
  ])

  const error = previewResult.error ?? previousResult.error
  if (error) return errorResponse(error.message, "No se pudo comparar el archivo con las ventas ya cargadas.")

  const statuses = (Array.isArray(previewResult.data) ? previewResult.data : []) as Array<{
    index: number
    status: MercadoLibrePreviewStatus
  }>

  const matches: Array<MercadoLibreProductMatch | null> = validation.rows.map(
    (row) => resolveMercadoLibreServerRow(row, matchingData).match,
  )

  return Response.json({
    statuses: statuses.map((item) => item.status),
    matches,
    previousImport: previousResult.data?.[0] ?? null,
    // El selector manual sólo hace falta cuando quedan líneas sin vincular.
    catalog: matches.some((match) => !match)
      ? matchingData.catalog.map((product) => ({
          id: product.id,
          nombre: product.nombre,
          sku: product.sku,
          activo: product.activo,
          producto_variantes: (product.producto_variantes ?? []).map((variant) => ({
            id: variant.id,
            nombre: variant.nombre,
            sku: variant.sku,
            activo: variant.activo,
          })),
        }))
      : null,
  })
}
