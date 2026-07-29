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

  if (
    receivedQuantity == null ||
    sellableQuantity == null ||
    discountedQuantity == null ||
    nonSellableQuantity == null
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

  const { data: sale, error: saleError } = await auth.admin
    .from("mercadolibre_sales")
    .select("id, product_id, quantity")
    .eq("id", id)
    .maybeSingle()

  if (saleError || !sale) {
    return Response.json(
      { error: "La venta de Mercado Libre ya no existe." },
      { status: 404 },
    )
  }
  if (!sale.product_id) {
    return Response.json(
      { error: "Primero vinculá la venta con un producto." },
      { status: 400 },
    )
  }
  if (receivedQuantity > Number(sale.quantity)) {
    return Response.json(
      { error: "No podés recibir más unidades que las vendidas." },
      { status: 400 },
    )
  }

  const { data: review, error } = await auth.admin
    .from("inventory_return_movements")
    .upsert(
      {
        source_key: `mercadolibre-sale:${sale.id}`,
        order_id: null,
        order_item_id: null,
        mercadolibre_sale_id: sale.id,
        product_id: sale.product_id,
        variant_id: null,
        quantity: sellableQuantity,
        received_quantity: receivedQuantity,
        sellable_quantity: sellableQuantity,
        discounted_quantity: discountedQuantity,
        non_sellable_quantity: nonSellableQuantity,
        discount_percent: discountPercent,
        discount_reason: discountedQuantity > 0 ? discountReason : null,
        non_sellable_reason:
          nonSellableQuantity > 0 ? nonSellableReason : null,
        review_notes: optionalText(body?.notes, 1000),
        approved_by: auth.user.id,
        approved_at: new Date().toISOString(),
      },
      { onConflict: "source_key" },
    )
    .select("*")
    .single()

  if (error) {
    const missingMigration =
      /mercadolibre_sale_id|received_quantity|sellable_quantity|discount_reason|schema cache/i.test(
        error.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 103_separate_conditioned_return_stock.sql."
          : "No se pudo guardar la revisión física.",
      },
      { status: missingMigration ? 503 : 500 },
    )
  }

  return Response.json({ review })
}
