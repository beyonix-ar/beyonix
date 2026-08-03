import { requireInternalUser } from "@/lib/auth/admin-api"
import { reconcileUnlinkedMercadoLibreSalesByExactSku } from "@/lib/mercadolibre/sku-reconciliation"

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

  const { data: currentSale, error: currentSaleError } = await auth.admin
    .from("mercadolibre_sales")
    .select("id, sku, product_id")
    .eq("id", id)
    .maybeSingle()

  if (currentSaleError) {
    return Response.json(
      { error: "No se pudo comprobar la vinculación de la venta." },
      { status: 500 },
    )
  }
  if (!currentSale) {
    return Response.json(
      { error: "La venta de Mercado Libre ya no existe." },
      { status: 404 },
    )
  }

  let linkedProductId = currentSale.product_id
  if (!linkedProductId && currentSale.sku) {
    await reconcileUnlinkedMercadoLibreSalesByExactSku(auth.admin, {
      sku: currentSale.sku,
      actorId: auth.user.id,
    })
    const { data: reconciledSale } = await auth.admin
      .from("mercadolibre_sales")
      .select("product_id")
      .eq("id", id)
      .maybeSingle()
    linkedProductId = reconciledSale?.product_id ?? null
  }

  if (!linkedProductId) {
    const skuLabel = currentSale.sku?.trim()
      ? `el SKU ${currentSale.sku.trim()}`
      : "esta venta"
    return Response.json(
      {
        error: `Primero vinculá ${skuLabel} con un producto antes de guardar la revisión física.`,
      },
      { status: 409 },
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
    const outdatedConditionConstraint =
      /inventory_return_movements_condition_check/i.test(error.message)
    const missingMigration =
      /review_mercadolibre_return|mercadolibre_sale_id|occurred_at|schema cache|PGRST202/i.test(
        error.message,
      )
    const missingProductLink =
      /Primero vinculá|debe estar vinculada a un producto/i.test(error.message)
    return Response.json(
      {
        error: outdatedConditionConstraint
          ? "La base de datos necesita la corrección de devoluciones 20260801103000 antes de guardar esta revisión."
          : missingMigration
            ? "Falta aplicar la migración 20260801091000_mercadolibre_returns_and_bulk_delete.sql."
            : missingProductLink
              ? "Primero vinculá el SKU de la venta con un producto antes de guardar la revisión física."
            : /STOCK_INSUFICIENTE/i.test(error.message)
              ? "No hay stock suficiente para reclasificar esta devolución."
              : "No se pudo guardar la revisión física.",
      },
      {
        status: outdatedConditionConstraint || missingMigration
          ? 503
          : missingProductLink
            ? 409
          : /STOCK_INSUFICIENTE/i.test(error.message)
            ? 409
            : 500,
      },
    )
  }

  return Response.json({ review })
}
