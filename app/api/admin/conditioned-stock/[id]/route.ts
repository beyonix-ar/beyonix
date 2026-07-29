import { requireInternalUser } from "@/lib/auth/admin-api"

function optionalText(value: unknown, max: number) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, max) : null
}

function validPercent(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed < 100
    ? parsed
    : null
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const { id } = await context.params
  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  if (!body) {
    return Response.json({ error: "Datos inválidos." }, { status: 400 })
  }

  const { data: current, error: currentError } = await auth.admin
    .from("inventory_return_movements")
    .select(
      "id, product_id, variant_id, discounted_quantity, discount_percent, discount_reason, non_sellable_quantity, non_sellable_reason, conditioned_active, approved_at",
    )
    .eq("id", id)
    .maybeSingle()

  if (currentError || !current) {
    const missingMigration =
      /conditioned_active|discount_reason|schema cache/i.test(
        currentError?.message ?? "",
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 104_conditioned_stock_management.sql."
          : "La unidad con descuento ya no existe.",
      },
      { status: missingMigration ? 503 : 404 },
    )
  }

  if (Number(current.discounted_quantity) <= 0) {
    return Response.json(
      { error: "Esta devolución ya no tiene unidades con descuento." },
      { status: 400 },
    )
  }

  const discountPercent =
    "discountPercent" in body
      ? validPercent(body.discountPercent)
      : Number(current.discount_percent)
  const discountReason =
    "discountReason" in body
      ? optionalText(body.discountReason, 300)
      : optionalText(current.discount_reason, 300)
  const nonSellableReason =
    "nonSellableReason" in body
      ? optionalText(body.nonSellableReason, 300)
      : optionalText(current.non_sellable_reason, 300)
  const active =
    typeof body.active === "boolean"
      ? body.active
      : current.conditioned_active === true

  if (discountPercent == null) {
    return Response.json(
      { error: "Indicá un descuento entre 0 y 100%." },
      { status: 400 },
    )
  }
  if (!discountReason) {
    return Response.json(
      { error: "Indicá el motivo del descuento." },
      { status: 400 },
    )
  }
  if (Number(current.non_sellable_quantity) > 0 && !nonSellableReason) {
    return Response.json(
      { error: "Indicá el motivo de las unidades no vendibles." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin
    .from("inventory_return_movements")
    .update({
      discount_percent: discountPercent,
      discount_reason: discountReason,
      non_sellable_reason:
        Number(current.non_sellable_quantity) > 0
          ? nonSellableReason
          : null,
      conditioned_active: active,
    })
    .eq("id", id)
    .select(
      "id, product_id, variant_id, discounted_quantity, discount_percent, discount_reason, non_sellable_quantity, non_sellable_reason, conditioned_active, approved_at",
    )
    .single()

  if (error) {
    return Response.json(
      { error: "No se pudo actualizar la unidad con descuento." },
      { status: 500 },
    )
  }

  return Response.json({ item: data })
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const { id } = await context.params
  const { data: current, error: currentError } = await auth.admin
    .from("inventory_return_movements")
    .select(
      "id, discounted_quantity, non_sellable_quantity, non_sellable_reason",
    )
    .eq("id", id)
    .maybeSingle()

  if (currentError || !current) {
    return Response.json(
      { error: "La unidad con descuento ya no existe." },
      { status: 404 },
    )
  }
  if (
    Number(current.non_sellable_quantity) > 0 &&
    !optionalText(current.non_sellable_reason, 300)
  ) {
    return Response.json(
      {
        error:
          "Completá primero el motivo de las unidades no vendibles desde el botón de editar.",
      },
      { status: 400 },
    )
  }

  const { error } = await auth.admin
    .from("inventory_return_movements")
    .update({
      discounted_quantity: 0,
      discount_percent: null,
      discount_reason: null,
      conditioned_active: false,
    })
    .eq("id", id)

  if (error) {
    return Response.json(
      { error: "No se pudo quitar la unidad con descuento." },
      { status: 500 },
    )
  }

  return Response.json({ deleted: true })
}
