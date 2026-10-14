import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  describeMercadoLibreImportError,
  isMissingImportMigration,
} from "@/lib/mercadolibre/import-validation"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ROLES = ["admin", "super_admin"] as const

function count(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0
}

function shortText(value: unknown, max: number) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null
}

function migrationOrGeneric(message: string, fallback: string) {
  console.error("ML_IMPORT_BATCH_ERROR", message)
  return Response.json(
    { error: describeMercadoLibreImportError(message, fallback) },
    { status: isMissingImportMigration(message) ? 503 : 500 },
  )
}

/** Historial: últimas importaciones, con quién las hizo y qué se puede revertir. */
export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("mercadolibre_import_batches")
    .select("id, created_at, finished_at, imported_by, source_file_name, file_kind, sheet_name, rows_read, rows_valid, rows_invalid, rows_duplicate_in_file, inserted, updated, unchanged, status, error_message, invalid_rows, reverted_at, reverted_count")
    .order("created_at", { ascending: false })
    .limit(20)
  if (error) return migrationOrGeneric(error.message, "No se pudo cargar el historial de importaciones.")

  const batches = data ?? []
  const batchIds = batches.map((batch) => batch.id)
  const userIds = [...new Set(batches.map((batch) => batch.imported_by).filter((id): id is string => Boolean(id)))]

  const [profilesResult, salesResult] = await Promise.all([
    userIds.length
      ? auth.admin.from("profiles").select("id, email").in("id", userIds)
      : Promise.resolve({ data: [] as Array<{ id: string; email: string | null }>, error: null }),
    batchIds.length
      ? auth.admin
          .from("mercadolibre_sales")
          .select("id, import_batch_id, last_import_batch_id, inventory_return_movements(id)")
          .in("import_batch_id", batchIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
  ])
  if (profilesResult.error || salesResult.error) {
    return migrationOrGeneric(
      profilesResult.error?.message ?? salesResult.error?.message ?? "",
      "No se pudo cargar el historial de importaciones.",
    )
  }

  const emails = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.email]))
  const reversibleByBatch = new Map<string, { reversible: number; kept: number }>()
  for (const sale of (salesResult.data ?? []) as Array<Record<string, unknown>>) {
    const batchId = String(sale.import_batch_id)
    const current = reversibleByBatch.get(batchId) ?? { reversible: 0, kept: 0 }
    const reviewed = Array.isArray(sale.inventory_return_movements) && sale.inventory_return_movements.length > 0
    if (sale.last_import_batch_id === sale.import_batch_id && !reviewed) current.reversible += 1
    else current.kept += 1
    reversibleByBatch.set(batchId, current)
  }

  return Response.json({
    batches: batches.map((batch) => ({
      ...batch,
      imported_by_email: batch.imported_by ? (emails.get(batch.imported_by) ?? null) : null,
      reversible_sales: reversibleByBatch.get(batch.id)?.reversible ?? 0,
      kept_sales: reversibleByBatch.get(batch.id)?.kept ?? 0,
    })),
  })
}

/** Abre un lote antes de enviar las ventas. */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: "Los datos de la importación llegaron incompletos." }, { status: 400 })
  }

  const fileSha256 = typeof body.fileSha256 === "string" && /^[0-9a-f]{64}$/.test(body.fileSha256) ? body.fileSha256 : null
  const fileKind = body.fileKind === "xlsx" || body.fileKind === "xls" || body.fileKind === "csv" ? body.fileKind : null
  const invalidRows = Array.isArray(body.invalidRows)
    ? body.invalidRows.slice(0, 200).map((row) => {
        const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {}
        return {
          rowNumber: count(item.rowNumber),
          saleNumber: shortText(item.saleNumber, 40),
          messages: Array.isArray(item.messages)
            ? item.messages.slice(0, 5).map((message) => shortText(message, 300)).filter(Boolean)
            : [],
        }
      })
    : []
  const columns = Array.isArray(body.columns)
    ? body.columns.slice(0, 120).map((column) => {
        const item = column && typeof column === "object" ? (column as Record<string, unknown>) : {}
        return { key: shortText(item.key, 60), header: shortText(item.header, 200), column: count(item.column) }
      })
    : []

  const { data, error } = await auth.admin
    .from("mercadolibre_import_batches")
    .insert({
      imported_by: auth.user.id,
      source_file_name: shortText(body.fileName, 255),
      file_sha256: fileSha256,
      file_kind: fileKind,
      sheet_name: shortText(body.sheetName, 120),
      columns,
      rows_read: count(body.rowsRead),
      rows_valid: count(body.rowsValid),
      rows_invalid: count(body.rowsInvalid),
      invalid_rows: invalidRows,
    })
    .select("id")
    .single()
  if (error || !data) return migrationOrGeneric(error?.message ?? "", "No se pudo iniciar la importación.")

  return Response.json({ batchId: data.id })
}

/** Cierra un lote: completado o fallido (con el motivo que vio el usuario). */
export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...ROLES])
  if ("error" in auth) return auth.error

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: "Los datos de la importación llegaron incompletos." }, { status: 400 })
  }
  const batchId = typeof body.batchId === "string" && UUID_PATTERN.test(body.batchId) ? body.batchId : null
  const status = body.status === "completed" || body.status === "failed" ? body.status : null
  if (!batchId || !status) return Response.json({ error: "Importación inválida." }, { status: 400 })

  const { data, error } = await auth.admin
    .from("mercadolibre_import_batches")
    .update({
      status,
      finished_at: new Date().toISOString(),
      error_message: status === "failed" ? shortText(body.errorMessage, 500) : null,
    })
    .eq("id", batchId)
    .eq("status", "processing")
    .select("id, status, inserted, updated, unchanged, rows_duplicate_in_file")
    .maybeSingle()
  if (error) return migrationOrGeneric(error.message, "No se pudo cerrar la importación.")
  if (!data) return Response.json({ error: "La importación ya estaba cerrada." }, { status: 409 })

  return Response.json({ batch: data })
}
