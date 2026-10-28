import {
  UUID_PATTERN,
  authorizeExternalSales,
  externalSalesDatabaseError,
  jsonError,
  readJsonObject,
} from "@/lib/admin/external-sales-api"

/**
 * Deshacer una tanda completa: anula (no borra) sus ventas y revierte stock
 * sólo de las nuevas. Bloqueado si alguna venta fue modificada después.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error
  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return jsonError("La tanda indicada no es válida.")

  const body = await readJsonObject(request)
  const expectedCount = Number(body?.expectedCount)
  const reason = typeof body?.reason === "string" ? body.reason.trim() : ""
  if (!Number.isInteger(expectedCount) || expectedCount < 1) return jsonError("La tanda indicada no es válida.")
  if (reason.length < 10 || reason.length > 500) return jsonError("Indicá el motivo (entre 10 y 500 caracteres).")

  const { data, error } = await auth.admin.rpc("revert_external_sale_import_batch", {
    p_batch_id: id,
    p_expected_count: expectedCount,
    p_reason: reason,
    p_actor_id: auth.user.id,
  })
  if (error) return externalSalesDatabaseError(error.message)
  return Response.json({ result: data })
}
