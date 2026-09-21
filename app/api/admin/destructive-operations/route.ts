import { requireInternalUser } from "@/lib/auth/admin-api"

function failure(message: string) {
  const conflict = /CONFLICT/.test(message)
  const missing = /NOT_FOUND/.test(message)
  return Response.json({ error: conflict
    ? "El stock o el historial cambió desde la vista previa. Recargá el impacto y confirmá nuevamente."
    : missing ? "El registro ya no existe. Actualizá el listado."
    : /CONFIRMATION/.test(message) ? "La confirmación escrita no coincide."
    : /STOCK_INSUFICIENTE|negative|negativo/.test(message) ? "El borrado dejaría stock insuficiente. Corregí los movimientos posteriores antes de eliminar esta compra."
    : "No se pudo completar la operación. Recargá el impacto; si persiste, contactá a soporte." }, { status: conflict ? 409 : missing ? 404 : 400 })
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, ["super_admin"])
  if ("error" in auth) return auth.error
  const params = new URL(request.url).searchParams
  const kind = params.get("kind")
  const id = params.get("id")
  if (!kind || !["purchase", "product", "variant"].includes(kind) || !id || id.length > 80) return failure("INVALID")
  const { data, error } = await auth.admin.rpc("admin_force_delete_impact", { p_kind: kind, p_id: id })
  if (error) return failure(error.message)
  return Response.json({ impact: data }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["super_admin"])
  if ("error" in auth) return auth.error
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body || typeof body.kind !== "string" || !["purchase", "product", "variant"].includes(body.kind) ||
      typeof body.id !== "string" || body.id.length > 80 || typeof body.confirmation !== "string" ||
      typeof body.fingerprint !== "string" || typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,240}$/.test(body.idempotencyKey)) return failure("INVALID")
  const { data, error } = await auth.admin.rpc("admin_confirm_force_delete", {
    p_kind: body.kind, p_id: body.id, p_actor_id: auth.user.id,
    p_confirmation: body.confirmation, p_fingerprint: body.fingerprint, p_idempotency_key: body.idempotencyKey,
  })
  if (error) return failure(error.message)
  return Response.json(data)
}
