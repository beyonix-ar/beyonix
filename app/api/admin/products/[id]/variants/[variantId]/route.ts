import { requireInternalUser } from "@/lib/auth/admin-api"

function parseId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function requiredText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null
  const normalized = value.trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function optionalText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null
  return value.trim().slice(0, maxLength) || null
}

function normalizedSku(value: unknown) {
  return optionalText(value, 120)?.toLocaleUpperCase("es") ?? null
}

function validColor(value: unknown) {
  const normalized = requiredText(value, 7)
  return normalized && /^#[0-9A-F]{6}$/i.test(normalized)
    ? normalized.toUpperCase()
    : null
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function imageUrls(value: unknown) {
  if (!Array.isArray(value)) return null
  const urls = value.filter(
    (item): item is string =>
      typeof item === "string" &&
      item.startsWith("https://") &&
      item.length <= 2000,
  )
  return urls.length === value.length ? urls : null
}

function variantMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const allowedKeys = new Set([
    "nombre",
    "sku",
    "color_hex",
    "imagenes",
    "orden",
  ])
  if (
    keys.length === 0 ||
    keys.some((key) => !allowedKeys.has(key))
  ) {
    return null
  }

  const payload: {
    nombre?: string
    sku?: string | null
    color_hex?: string
    imagenes?: string[]
    orden?: number
  } = {}

  if ("nombre" in record) {
    const name = requiredText(record.nombre, 160)
    if (!name) return null
    payload.nombre = name
  }
  if ("sku" in record) {
    if (record.sku != null && typeof record.sku !== "string") return null
    payload.sku = optionalText(record.sku ?? "", 120)
  }
  if ("color_hex" in record) {
    const color = validColor(record.color_hex)
    if (!color) return null
    payload.color_hex = color
  }
  if ("imagenes" in record) {
    const images = imageUrls(record.imagenes)
    if (!images) return null
    payload.imagenes = images
  }
  if ("orden" in record) {
    const order = parseId(String(record.orden))
    if (!order) return null
    payload.orden = order
  }

  return payload
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const params = await context.params
  const productId = parseId(params.id)
  const variantId = parseId(params.variantId)

  if (!productId || !variantId) {
    return Response.json(
      { error: "La variante indicada no es válida." },
      { status: 400 },
    )
  }

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null

  if (!body) {
    return Response.json(
      { error: "Los datos de la variante no son válidos." },
      { status: 400 },
    )
  }

  if ("metadata" in body) {
    const metadata = variantMetadata(body.metadata)
    if (!metadata) {
      return Response.json(
        { error: "Los datos complementarios de la variante no son válidos." },
        { status: 400 },
      )
    }

    if (metadata.sku) {
      const registry = await auth.admin
        .from("catalog_sku_registry")
        .select("product_id, variant_id")
        .eq("normalized_sku", normalizedSku(metadata.sku))
        .maybeSingle()

      if (registry.error) {
        return Response.json(
          { error: "No se pudo validar la identidad SKU." },
          { status: 500 },
        )
      }

      const belongsToCurrentVariant =
        Number(registry.data?.product_id) === productId &&
        Number(registry.data?.variant_id) === variantId
      if (registry.data && !belongsToCurrentVariant) {
        return Response.json(
          { error: `El SKU ${metadata.sku} ya está asignado a otro artículo.` },
          { status: 409 },
        )
      }
    }

    const { data: updated, error: updateError } = await auth.admin
      .from("producto_variantes")
      .update(metadata)
      .eq("id", variantId)
      .eq("producto_id", productId)
      .select("*")
      .maybeSingle()

    if (updateError) {
      return Response.json(
        {
          error:
            updateError.message ||
            "No se pudo actualizar la variante.",
        },
        { status: 409 },
      )
    }
    if (!updated) {
      return Response.json(
        { error: "La variante ya no existe." },
        { status: 404 },
      )
    }

    return Response.json({ variant: updated })
  }

  if (typeof body.activo !== "boolean") {
    const name = requiredText(body.name, 160)
    const sku = optionalText(body.sku, 120)
    const color = validColor(body.color)
    const quantity = nonNegativeInteger(body.quantity)
    const images = imageUrls(body.images)
    if (!name || !color || quantity == null || !images) {
      return Response.json(
        { error: "Completá correctamente la variante y sus unidades." },
        { status: 400 },
      )
    }

    const [currentResult, allocationsResult] = await Promise.all([
      auth.admin
        .from("producto_variantes")
        .select("*")
        .eq("id", variantId)
        .eq("producto_id", productId)
        .maybeSingle(),
      auth.admin
        .from("inventory_variant_allocations")
        .select("variant_id, quantity")
        .eq("product_id", productId),
    ])
    if (currentResult.error || allocationsResult.error) {
      return Response.json(
        { error: "No se pudo preparar la actualización de la variante." },
        { status: 500 },
      )
    }
    if (!currentResult.data) {
      return Response.json(
        { error: "La variante ya no existe." },
        { status: 404 },
      )
    }

    const skuKey = normalizedSku(sku)
    if (skuKey) {
      const registry = await auth.admin
        .from("catalog_sku_registry")
        .select("product_id, variant_id")
        .eq("normalized_sku", skuKey)
        .maybeSingle()
      if (registry.error) {
        return Response.json(
          { error: "No se pudo validar la identidad SKU." },
          { status: 500 },
        )
      }
      const duplicate =
        Boolean(registry.data) &&
        Number(registry.data?.variant_id) !== variantId
      if (duplicate) {
        return Response.json(
          { error: `El SKU ${sku} ya está asignado a otro artículo.` },
          { status: 409 },
        )
      }
    }

    const atomicResult = await auth.admin.rpc(
      "update_product_variant_with_allocation",
      {
        p_product_id: productId,
        p_variant_id: variantId,
        p_name: name,
        p_sku: sku,
        p_color_hex: color,
        p_images: images,
        p_quantity: quantity,
        p_actor_id: auth.user.id,
      },
    )
    const atomicFunctionMissing =
      atomicResult.error &&
      /update_product_variant_with_allocation|schema cache|PGRST202/i.test(
        atomicResult.error.message,
      )
    if (!atomicResult.error) {
      const updated = Array.isArray(atomicResult.data)
        ? atomicResult.data[0]
        : atomicResult.data
      return Response.json({ variant: updated })
    }
    if (!atomicFunctionMissing) {
      return Response.json(
        { error: atomicResult.error.message },
        { status: 409 },
      )
    }

    const { data: updated, error: updateError } = await auth.admin
      .from("producto_variantes")
      .update({
        nombre: name,
        sku,
        color_hex: color,
        imagenes: images,
      })
      .eq("id", variantId)
      .eq("producto_id", productId)
      .select("*")
      .single()
    if (updateError) {
      return Response.json(
        { error: updateError.message },
        { status: 409 },
      )
    }

    const allocations = (allocationsResult.data ?? []).map((allocation) => ({
      variant_id: Number(allocation.variant_id),
      quantity:
        Number(allocation.variant_id) === variantId
          ? quantity
          : Number(allocation.quantity),
    }))
    if (!allocations.some((item) => item.variant_id === variantId)) {
      allocations.push({ variant_id: variantId, quantity })
    }
    const { error: allocationError } = await auth.admin.rpc(
      "set_product_variant_allocations",
      {
        p_product_id: productId,
        p_allocations: allocations,
        p_actor_id: auth.user.id,
      },
    )
    if (allocationError) {
      const previous = currentResult.data
      await auth.admin
        .from("producto_variantes")
        .update({
          nombre: previous.nombre,
          sku: previous.sku,
          color_hex: previous.color_hex,
          imagenes: previous.imagenes,
        })
        .eq("id", variantId)
      return Response.json(
        { error: allocationError.message },
        { status: 409 },
      )
    }

    return Response.json({ variant: updated })
  }

  const { data: variant, error: variantError } = await auth.admin
    .from("producto_variantes")
    .select("id, producto_id, productos(activo)")
    .eq("id", variantId)
    .eq("producto_id", productId)
    .maybeSingle()

  if (variantError) {
    return Response.json(
      { error: "No se pudo consultar la variante." },
      { status: 500 },
    )
  }

  if (!variant) {
    return Response.json(
      { error: "La variante ya no existe." },
      { status: 404 },
    )
  }

  const relatedProduct = Array.isArray(variant.productos)
    ? variant.productos[0]
    : variant.productos

  if (updates.activo === true && relatedProduct?.activo === false) {
    return Response.json(
      {
        error:
          "Activá primero el producto principal para habilitar esta variante.",
      },
      { status: 409 },
    )
  }

  const { data: updated, error: updateError } = await auth.admin
    .from("producto_variantes")
    .update(updates)
    .eq("id", variantId)
    .eq("producto_id", productId)
    .select("*")
    .single()

  if (updateError) {
    return Response.json(
      {
        error:
          updateError.message || "No se pudo cambiar el estado de la variante.",
      },
      { status: 500 },
    )
  }

  return Response.json({ variant: updated })
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; variantId: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const params = await context.params
  const productId = parseId(params.id)
  const variantId = parseId(params.variantId)
  if (!productId || !variantId) {
    return Response.json(
      { error: "La variante indicada no es válida." },
      { status: 400 },
    )
  }

  const { data: deleted, error: deleteError } = await auth.admin
    .from("producto_variantes")
    .delete()
    .eq("id", variantId)
    .eq("producto_id", productId)
    .select("id")
    .maybeSingle()

  if (deleteError) {
    const isReferenced = deleteError.code === "23503"
    return Response.json(
      {
        error: isReferenced
          ? "La variante tiene movimientos asociados y no puede eliminarse."
          : deleteError.message || "No se pudo eliminar la variante.",
      },
      { status: isReferenced ? 409 : 500 },
    )
  }
  if (!deleted) {
    return Response.json(
      { error: "La variante ya no existe." },
      { status: 404 },
    )
  }

  return Response.json({ deleted: true })
}
