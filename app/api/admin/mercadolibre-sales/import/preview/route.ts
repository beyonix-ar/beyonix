import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  describeMercadoLibreImportError,
  isMissingImportMigration,
  validateMercadoLibreServerRows,
  type MercadoLibrePreviewStatus,
} from "@/lib/mercadolibre/import-validation"

/**
 * Compara un bloque del archivo contra lo ya cargado, sin escribir nada:
 * cuántas ventas son nuevas, cuáles ya existen y si el archivo las cambiaría.
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
  if (error) {
    console.error("ML_IMPORT_PREVIEW_ERROR", error.message)
    return Response.json(
      { error: describeMercadoLibreImportError(error.message, "No se pudo comparar el archivo con las ventas ya cargadas.") },
      { status: isMissingImportMigration(error.message) ? 503 : 500 },
    )
  }

  const statuses = (Array.isArray(previewResult.data) ? previewResult.data : []) as Array<{
    index: number
    status: MercadoLibrePreviewStatus
  }>

  return Response.json({
    statuses: statuses.map((item) => item.status),
    previousImport: previousResult.data?.[0] ?? null,
  })
}
