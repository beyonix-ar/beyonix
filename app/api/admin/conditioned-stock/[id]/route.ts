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

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function requiredText(value: unknown, max: number) {
  return optionalText(value, max)
}

function validColor(value: unknown) {
  const normalized = requiredText(value, 7)
  return normalized && /^#[0-9A-F]{6}$/i.test(normalized)
    ? normalized.toUpperCase()
    : null
}

function normalizedSku(value: string) {
  return value.trim().toLocaleUpperCase("es")
}

function imageUrls(value: unknown) {
  if (!Array.isArray(value)) return null
  const images = value.filter(
    (image): image is string =>
      typeof image === "string" &&
      image.startsWith("https://") &&
      image.length <= 2000,
  )
  return images.length === value.length ? images : null
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
      "id, product_id, variant_id, discounted_quantity, discount_percent, discount_reason, non_sellable_quantity, non_sellable_reason, conditioned_active, conditioned_name, conditioned_sku, conditioned_color_hex, conditioned_images, approved_at",
    )
    .eq("id", id)
    .maybeSingle()

  if (currentError || !current) {
    const missingMigration =
      /conditioned_active|conditioned_name|conditioned_sku|conditioned_color_hex|conditioned_images|discount_reason|schema cache/i.test(
        currentError?.message ?? "",
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración de variantes con descuento."
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
  const wantsConditionedIdentity =
    "sourceVariantId" in body ||
    "conditionedName" in body ||
    "conditionedSku" in body ||
    "conditionedColor" in body ||
    "conditionedImages" in body

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

  let sourceVariantId = current.variant_id
  let conditionedName = current.conditioned_name
  let conditionedSku = current.conditioned_sku
  let conditionedColor = current.conditioned_color_hex
  let conditionedImages = Array.isArray(current.conditioned_images)
    ? current.conditioned_images
    : []

  if (wantsConditionedIdentity) {
    sourceVariantId =
      body.sourceVariantId == null
        ? null
        : positiveInteger(body.sourceVariantId)
    conditionedName = requiredText(body.conditionedName, 160)
    conditionedSku = requiredText(body.conditionedSku, 120)
    conditionedColor = validColor(body.conditionedColor)
    const parsedConditionedImages = imageUrls(body.conditionedImages)
    conditionedImages = parsedConditionedImages ?? []
    if (
      (body.sourceVariantId != null && !sourceVariantId) ||
      !conditionedName ||
      !conditionedSku ||
      !conditionedColor ||
      parsedConditionedImages == null
    ) {
      return Response.json(
        {
          error:
            "Completá correctamente el nombre, SKU, color e imágenes de la variante con descuento.",
        },
        { status: 400 },
      )
    }

    if (sourceVariantId) {
      const { data: variant, error: variantError } = await auth.admin
        .from("producto_variantes")
        .select("id")
        .eq("id", sourceVariantId)
        .eq("producto_id", current.product_id)
        .maybeSingle()

      if (variantError) {
        return Response.json(
          { error: "No se pudo consultar la variante original." },
          { status: 500 },
        )
      }
      if (!variant) {
        return Response.json(
          { error: "La variante original no pertenece a este producto." },
          { status: 409 },
        )
      }
    }

    const registry = await auth.admin
      .from("catalog_sku_registry")
      .select("conditioned_stock_id")
      .eq("normalized_sku", normalizedSku(conditionedSku))
      .maybeSingle()
    const missingRegistryMigration =
      registry.error &&
      /conditioned_stock_id|schema cache/i.test(registry.error.message)
    if (registry.error) {
      return Response.json(
        {
          error: missingRegistryMigration
            ? "Falta aplicar la migración de variantes con descuento."
            : "No se pudo validar la identidad SKU.",
        },
        { status: missingRegistryMigration ? 503 : 500 },
      )
    }
    if (
      registry.data &&
      registry.data.conditioned_stock_id !== current.id
    ) {
      return Response.json(
        {
          error: `El SKU ${conditionedSku} ya está asignado a otro artículo.`,
        },
        { status: 409 },
      )
    }
  }

  if (
    active &&
    (
      !requiredText(conditionedName, 160) ||
      !requiredText(conditionedSku, 120) ||
      !validColor(conditionedColor)
    )
  ) {
    return Response.json(
      {
        error:
          "Completá la variante con descuento antes de habilitarla para la venta.",
      },
      { status: 409 },
    )
  }

  if (active) {
    const { data: availability, error: availabilityError } = await auth.admin
      .from("conditioned_inventory_offers")
      .select("available_quantity")
      .eq("id", id)
      .maybeSingle()

    if (availabilityError) {
      return Response.json(
        {
          error:
            /conditioned_inventory_offers|schema cache/i.test(
              availabilityError.message,
            )
              ? "Falta aplicar la migración de variantes vendibles con descuento."
              : "No se pudo validar la disponibilidad de la variante con descuento.",
        },
        { status: 503 },
      )
    }

    if (
      availability &&
      Number(availability.available_quantity) <= 0
    ) {
      return Response.json(
        {
          error:
            "La variante con descuento ya no tiene unidades disponibles.",
        },
        { status: 409 },
      )
    }
  }

  if (sourceVariantId !== current.variant_id) {
    if (!sourceVariantId) {
      return Response.json(
        {
          error:
            "No se puede desvincular una variante desde esta edición porque cambiaría el sublibro de stock.",
        },
        { status: 409 },
      )
    }

    const { error: linkError } = await auth.admin.rpc(
      "link_conditioned_stock_variant_idempotent",
      {
        p_return_id: current.id,
        p_variant_id: sourceVariantId,
        p_actor_id: auth.user.id,
        p_idempotency_key: `conditioned-link:${current.id}:${sourceVariantId}`,
        p_document_reference: `inventory-return:${current.id}`,
      },
    )

    if (linkError) {
      const missingMigration =
        /link_conditioned_stock_variant_idempotent|PGRST202|schema cache/i.test(
          linkError.message,
        )
      return Response.json(
        {
          error: missingMigration
            ? "Falta aplicar la migración de integridad de inventario."
            : "No se pudo vincular la variante sin alterar el inventario.",
        },
        { status: missingMigration ? 503 : 409 },
      )
    }
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
      conditioned_name: conditionedName,
      conditioned_sku: conditionedSku,
      conditioned_color_hex: conditionedColor,
      conditioned_images: conditionedImages,
    })
    .eq("id", id)
    .select(
      "id, product_id, variant_id, discounted_quantity, discount_percent, discount_reason, non_sellable_quantity, non_sellable_reason, conditioned_active, conditioned_name, conditioned_sku, conditioned_color_hex, conditioned_images, approved_at",
    )
    .single()

  if (error) {
    const missingMigration =
      /conditioned_name|conditioned_sku|conditioned_color_hex|conditioned_images|schema cache/i.test(
        error.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración de variantes con descuento."
          : error.message || "No se pudo actualizar la unidad con descuento.",
      },
      { status: missingMigration ? 503 : 500 },
    )
  }

  const { data: availability } = await auth.admin
    .from("conditioned_inventory_offers")
    .select("original_quantity, sold_quantity, available_quantity")
    .eq("id", id)
    .maybeSingle()

  return Response.json({
    item: {
      ...data,
      original_quantity:
        availability?.original_quantity ?? data.discounted_quantity,
      sold_quantity: availability?.sold_quantity ?? 0,
      available_quantity:
        availability?.available_quantity ?? data.discounted_quantity,
    },
  })
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

  const { data: availability } = await auth.admin
    .from("conditioned_inventory_offers")
    .select("sold_quantity")
    .eq("id", id)
    .maybeSingle()

  if (Number(availability?.sold_quantity ?? 0) > 0) {
    const { error } = await auth.admin
      .from("inventory_return_movements")
      .update({ conditioned_active: false })
      .eq("id", id)

    if (error) {
      return Response.json(
        { error: "No se pudo archivar la variante con descuento." },
        { status: 500 },
      )
    }

    return Response.json({ deleted: false, archived: true })
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

  return Response.json({ deleted: true, archived: false })
}
