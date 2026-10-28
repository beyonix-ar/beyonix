import {
  authorizeExternalSales,
  externalSalesDatabaseError,
  jsonError,
  readJsonObject,
} from "@/lib/admin/external-sales-api"
import {
  EXTERNAL_SALE_IMPORT_MAX_ROWS,
  validateExternalSaleImportRow,
} from "@/lib/business/external-sales"

/** Previsualización: resuelve SKUs, stock disponible y posibles duplicados. No escribe nada. */
export async function POST(request: Request) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error

  const body = await readJsonObject(request)
  const rows = body?.rows
  if (!Array.isArray(rows) || rows.length === 0) return jsonError("No hay filas válidas para previsualizar.")
  if (rows.length > EXTERNAL_SALE_IMPORT_MAX_ROWS) {
    return jsonError(`Se pueden previsualizar hasta ${EXTERNAL_SALE_IMPORT_MAX_ROWS} filas por tanda.`)
  }
  const validated = rows.map(validateExternalSaleImportRow)
  const invalid = validated.findIndex((row) => row === null)
  if (invalid >= 0) return jsonError(`La fila ${invalid + 1} del preview no tiene un formato válido.`)

  const { data, error } = await auth.admin.rpc("preview_external_sales_import", { p_rows: validated })
  if (error) return externalSalesDatabaseError(error.message)
  return Response.json({ preview: data }, { headers: { "Cache-Control": "private, no-store" } })
}
