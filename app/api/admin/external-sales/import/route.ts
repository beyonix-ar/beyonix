import {
  authorizeExternalSales,
  externalSalesDatabaseError,
  idempotencyKeyFrom,
  jsonError,
  readJsonObject,
} from "@/lib/admin/external-sales-api"
import {
  EXTERNAL_SALE_IMPORT_MAX_ROWS,
  validateExternalSaleImportRow,
} from "@/lib/business/external-sales"

/**
 * Confirma una tanda. stockMode es obligatorio: "none" (Históricas: no mueven
 * stock) o "consume" (Nuevas: descuentan stock). Nunca se deduce de la fecha.
 */
export async function POST(request: Request) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error

  const key = idempotencyKeyFrom(request.headers.get("Idempotency-Key"))
  if (!key) return jsonError("Falta una clave de operación válida.")
  const body = await readJsonObject(request)
  if (!body) return jsonError("La importación no es válida.")
  if (body.stockMode !== "none" && body.stockMode !== "consume") {
    return jsonError("Elegí si las ventas son Históricas (no mueven stock) o Nuevas (descuentan stock).")
  }
  if (body.source !== "paste" && body.source !== "file") return jsonError("El origen de la importación no es válido.")
  const fileName = typeof body.fileName === "string" ? body.fileName.trim().slice(0, 255) : ""
  if (body.source === "file" && !fileName) return jsonError("Falta el nombre del archivo importado.")
  const rows = body.rows
  if (!Array.isArray(rows) || rows.length === 0) return jsonError("No hay ventas válidas para importar.")
  if (rows.length > EXTERNAL_SALE_IMPORT_MAX_ROWS) {
    return jsonError(`Cada tanda puede tener como máximo ${EXTERNAL_SALE_IMPORT_MAX_ROWS} ventas.`)
  }
  const validated = rows.map(validateExternalSaleImportRow)
  const invalid = validated.findIndex((row) => row === null)
  if (invalid >= 0) return jsonError(`La fila ${invalid + 1} no tiene un formato válido.`)
  const rowsRead = Number(body.rowsRead)

  const { data, error } = await auth.admin.rpc("import_external_sales_batch", {
    p_batch: {
      source: body.source,
      file_name: body.source === "file" ? fileName : null,
      stock_mode: body.stockMode,
      rows_read: Number.isInteger(rowsRead) && rowsRead >= rows.length ? rowsRead : rows.length,
    },
    p_rows: validated,
    p_actor_id: auth.user.id,
    p_idempotency_key: key,
  })
  if (error) return externalSalesDatabaseError(error.message)
  return Response.json({ result: data }, { status: 201 })
}
