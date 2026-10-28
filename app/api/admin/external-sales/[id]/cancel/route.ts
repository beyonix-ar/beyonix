import {
  UUID_PATTERN,
  authorizeExternalSales,
  externalSalesDatabaseError,
  idempotencyKeyFrom,
  jsonError,
  readJsonObject,
  withReportedProfit,
} from "@/lib/admin/external-sales-api"

/**
 * Anular venta / registrar devolución. kind = entry_error (la venta nunca
 * ocurrió) o return (devolución real, con returnCondition sellable | damaged).
 * El stock sólo vuelve si la venta descontaba stock y no volvió dañada.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizeExternalSales(request)
  if ("error" in auth) return auth.error
  const { id } = await context.params
  if (!UUID_PATTERN.test(id)) return jsonError("La venta indicada no es válida.")

  const body = await readJsonObject(request)
  const kind = body?.kind
  const condition = body?.returnCondition ?? null
  const reason = typeof body?.reason === "string" ? body.reason.trim() : ""
  const key = idempotencyKeyFrom(typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null)
  const version = body?.version == null ? null : Number(body.version)

  if (kind !== "entry_error" && kind !== "return") return jsonError("Elegí si fue un error de carga o una devolución.")
  if (kind === "return" && condition !== "sellable" && condition !== "damaged") {
    return jsonError("Indicá si el producto volvió en condición vendible.")
  }
  if (reason.length < 10 || reason.length > 500) return jsonError("Indicá el motivo (entre 10 y 500 caracteres).")
  if (!key) return jsonError("No se pudo identificar la operación de forma segura.")
  if (version != null && !(Number.isInteger(version) && version > 0)) return jsonError("La versión de la venta no es válida.")

  const { data, error } = await auth.admin.rpc("cancel_external_sale", {
    p_id: id,
    p_kind: kind,
    p_return_condition: kind === "return" ? condition : null,
    p_reason: reason,
    p_actor_id: auth.user.id,
    p_idempotency_key: key,
    p_expected_version: version,
  })
  if (error) return externalSalesDatabaseError(error.message)
  return Response.json({ sale: withReportedProfit(data as Record<string, unknown>) })
}
