import { requireInternalUser } from "@/lib/auth/admin-api"

function normalizedText(value: unknown, max: number) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, max) : null
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const { id } = await context.params
  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  const reason = normalizedText(body?.reason, 500)
  const idempotencyKey = normalizedText(body?.idempotencyKey, 240)

  if (!id || !reason || reason.length < 10) {
    return Response.json(
      { error: "Indicá el motivo de la reversión (mínimo 10 caracteres)." },
      { status: 400 },
    )
  }
  if (!idempotencyKey || idempotencyKey.length < 8) {
    return Response.json(
      { error: "No se pudo identificar la operación de forma segura." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin.rpc("reverse_external_sale", {
    p_id: id,
    p_reason: reason,
    p_actor_id: auth.user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    const alreadyReversed = /EXTERNAL_SALE_ALREADY_REVERSED/i.test(error.message)
    return Response.json(
      {
        error: alreadyReversed
          ? "La venta ya fue reversada por otra operación."
          : "No se pudo reversar la venta externa.",
      },
      { status: alreadyReversed ? 409 : 500 },
    )
  }

  return Response.json({ item: data })
}
