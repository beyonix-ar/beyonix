import { requireInternalUser } from "@/lib/auth/admin-api"
import { validateMercadoLibreImportBatch } from "@/lib/mercadolibre/import-integrity"
import {
  describeMercadoLibreImportError,
  isMissingImportMigration,
  validateMercadoLibreServerRows,
  type MercadoLibreServerRow,
} from "@/lib/mercadolibre/import-validation"
import {
  MercadoLibreMatchingLoadError,
  buildMercadoLibreImportPayload,
  loadMercadoLibreMatchingData,
} from "@/lib/mercadolibre/product-matching-server"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Importa un bloque (≤ 500 filas) de un lote ya creado. Cada bloque es
 * atómico: o se guardan todas sus filas o ninguna. Las filas se revalidan
 * acá; el análisis del navegador nunca se toma como válido por sí solo. El
 * vínculo con el catálogo y el efecto sobre el stock (modo del lote) se
 * deciden en el servidor.
 */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  let body: { rows?: unknown; batchId?: unknown; allowUnlinked?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ error: "El envío de ventas llegó incompleto. Volvé a intentarlo." }, { status: 400 })
  }

  const batchId = typeof body.batchId === "string" ? body.batchId : ""
  if (!UUID_PATTERN.test(batchId)) {
    return Response.json({ error: "Falta la importación a la que pertenecen estas ventas. Volvé a analizar el archivo." }, { status: 400 })
  }

  const validation = validateMercadoLibreServerRows(body.rows)
  if (!validation.ok) return Response.json({ error: validation.error }, { status: 400 })

  let integrityResult: ReturnType<typeof validateMercadoLibreImportBatch<MercadoLibreServerRow>>
  try {
    integrityResult = validateMercadoLibreImportBatch(validation.rows)
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "El archivo contiene ventas inconsistentes." },
      { status: 400 },
    )
  }

  let matchingData: Awaited<ReturnType<typeof loadMercadoLibreMatchingData>>
  try {
    matchingData = await loadMercadoLibreMatchingData(auth.admin, integrityResult.rows)
  } catch (error) {
    const detail = error instanceof MercadoLibreMatchingLoadError ? error.detail : ""
    console.error("ML_IMPORT_MATCHING_ERROR", detail || error)
    return Response.json(
      {
        error: describeMercadoLibreImportError(
          detail,
          `${error instanceof MercadoLibreMatchingLoadError ? error.message : "No se pudo vincular el catálogo."} No se guardó ningún cambio de este bloque.`,
        ),
      },
      { status: isMissingImportMigration(detail) ? 503 : 500 },
    )
  }

  const { payload, unlinked, newUnlinked } = buildMercadoLibreImportPayload(integrityResult.rows, matchingData, {
    actorId: auth.user.id,
    mappedAt: new Date().toISOString(),
  })

  // Nunca se importan líneas sin producto en silencio. Si el lote descuenta
  // stock no hay excepción posible para una venta nueva: cada salida necesita
  // su producto. Una venta ya existente sin vínculo (legado consume o none)
  // conserva su estado y sólo se vincula a mano. Si el lote no descuenta, el
  // administrador puede aceptar explícitamente dejarlas pendientes (sin costo
  // ni movimiento de stock).
  let batchConsumes = false
  if (unlinked > 0) {
    const { data: batch, error: batchError } = await auth.admin
      .from("mercadolibre_import_batches")
      .select("stock_effect")
      .eq("id", batchId)
      .maybeSingle()
    if (batchError) {
      console.error("ML_IMPORT_BATCH_LOOKUP_ERROR", batchError.message)
      return Response.json(
        { error: describeMercadoLibreImportError(batchError.message, "No se pudo verificar la importación. No se guardó ningún cambio de este bloque.") },
        { status: isMissingImportMigration(batchError.message) ? 503 : 500 },
      )
    }
    batchConsumes = batch?.stock_effect === "consume"
    if (batchConsumes && newUnlinked > 0) {
      return Response.json(
        { error: describeMercadoLibreImportError("ML_IMPORT_UNLINKED_CONSUME", ""), unlinked: newUnlinked },
        { status: 409 },
      )
    }
  }
  if (unlinked > 0 && !batchConsumes && body.allowUnlinked !== true) {
    return Response.json(
      { error: describeMercadoLibreImportError("ML_IMPORT_UNLINKED", ""), unlinked },
      { status: 409 },
    )
  }

  const { data: importResult, error: importError } = await auth.admin.rpc(
    "import_mercadolibre_sales_batch",
    {
      p_batch_id: batchId,
      p_rows: payload,
      p_imported_by: auth.user.id,
    },
  )

  if (importError) {
    console.error("ML_IMPORT_RPC_ERROR", importError.message)
    const missingMigration = isMissingImportMigration(importError.message)
    return Response.json(
      {
        error: describeMercadoLibreImportError(
          importError.message,
          "No se pudo guardar este bloque de ventas. No se guardó ningún cambio de este bloque.",
        ),
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  const result = (importResult && typeof importResult === "object" ? importResult : {}) as Record<string, unknown>

  return Response.json({
    received: payload.length,
    inserted: Number(result.inserted ?? 0),
    updated: Number(result.updated ?? 0),
    unchanged: Number(result.unchanged ?? 0),
    duplicateRows: integrityResult.duplicateRows + Number(result.duplicate_rows ?? 0),
    linked: payload.filter((row) => row.product_id != null).length,
  })
}
