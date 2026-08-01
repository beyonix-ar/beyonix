import { requireInternalUser } from "@/lib/auth/admin-api"

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function optionalText(value: unknown, max: number) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, max) : null
}

function optionalDateTime(value: unknown) {
  if (value == null || value === "") return null
  if (typeof value !== "string") return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
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
  const receivedQuantity = nonNegativeInteger(body?.receivedQuantity)
  const sellableQuantity = nonNegativeInteger(body?.sellableQuantity)
  const discountedQuantity = nonNegativeInteger(body?.discountedQuantity)
  const nonSellableQuantity = nonNegativeInteger(body?.nonSellableQuantity)
  const discountPercent =
    discountedQuantity && discountedQuantity > 0
      ? Number(body?.discountPercent)
      : null
  const discountReason = optionalText(body?.discountReason, 300)
  const nonSellableReason = optionalText(body?.nonSellableReason, 300)
  const occurredAt = optionalDateTime(body?.occurredAt)

  if (
    receivedQuantity == null ||
    sellableQuantity == null ||
    discountedQuantity == null ||
    nonSellableQuantity == null ||
    occurredAt === undefined
  ) {
    return Response.json(
      { error: "Las cantidades de la revisión no son válidas." },
      { status: 400 },
    )
  }

  if (
    sellableQuantity + discountedQuantity + nonSellableQuantity >
    receivedQuantity
  ) {
    return Response.json(
      { error: "La clasificación supera las unidades recibidas." },
      { status: 400 },
    )
  }

  if (
    discountedQuantity > 0 &&
    (
      !Number.isFinite(discountPercent) ||
      discountPercent == null ||
      discountPercent <= 0 ||
      discountPercent >= 100
    )
  ) {
    return Response.json(
      { error: "Indicá un descuento entre 0 y 100%." },
      { status: 400 },
    )
  }

  if (discountedQuantity > 0 && !discountReason) {
    return Response.json(
      { error: "Indicá el motivo del descuento." },
      { status: 400 },
    )
  }

  if (nonSellableQuantity > 0 && !nonSellableReason) {
    return Response.json(
      { error: "Indicá por qué las unidades no son vendibles." },
      { status: 400 },
    )
  }

  const { data: review, error } = await auth.admin.rpc(
    "review_mercadolibre_return",
    {
      p_sale_id: id,
      p_received_quantity: receivedQuantity,
      p_sellable_quantity: sellableQuantity,
      p_discounted_quantity: discountedQuantity,
      p_non_sellable_quantity: nonSellableQuantity,
      p_discount_percent: discountPercent,
      p_discount_reason: discountReason,
      p_non_sellable_reason: nonSellableReason,
      p_notes: optionalText(body?.notes, 1000),
      p_occurred_at: occurredAt,
      p_reviewed_by: auth.user.id,
    },
  )

  if (error) {
    const missingMigration =
      /review_mercadolibre_return|mercadolibre_sale_id|occurred_at|schema cache|PGRST202/i.test(
        error.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260801091000_mercadolibre_returns_and_bulk_delete.sql."
          : error.message || "No se pudo guardar la revisión física.",
      },
      {
        status: missingMigration
          ? 503
          : /STOCK_INSUFICIENTE/i.test(error.message)
            ? 409
            : 500,
      },
    )
  }

  return Response.json({ review })
}
