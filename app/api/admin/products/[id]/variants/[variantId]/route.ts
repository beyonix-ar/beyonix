import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  parseOptionalProductLogistics,
  ProductLogisticsValidationError,
  PRODUCT_LOGISTICS_FIELDS,
  type ProductLogisticsValues,
} from "@/lib/shipping/logistics-validation"
import { catalogSkuConflictMessage } from "@/lib/products/catalog-sku-conflict"

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
    ...PRODUCT_LOGISTICS_FIELDS.map(({ key }) => key),
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
  } & Partial<ProductLogisticsValues> = {}

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
  try {
    const logistics = parseOptionalProductLogistics(record)
    for (const { key } of PRODUCT_LOGISTICS_FIELDS) {
      if (key in record) payload[key] = logistics[key]
    }
  } catch {
    return null
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
          {
            error: await catalogSkuConflictMessage(
              auth.admin,
              metadata.sku,
              registry.data,
            ),
          },
          { status: 409 },
        )
      }
    }

    const { data: atomicData, error: updateError } = await auth.admin.rpc(
      "update_product_variant_metadata_atomic",
      {
        p_product_id: productId,
        p_variant_id: variantId,
        p_metadata: metadata,
        p_actor_id: auth.user.id,
      },
    )

    if (updateError) {
      const missingMigration =
        /update_product_variant_metadata_atomic|schema cache|PGRST202/i.test(
          updateError.message,
        )
      return Response.json(
        {
          error: missingMigration
            ? "Falta aplicar la migración 20260808120000_atomic_product_catalog_workflow.sql."
            : updateError.message || "No se pudo actualizar la variante.",
        },
        { status: missingMigration ? 503 : 409 },
      )
    }
    const updated = Array.isArray(atomicData) ? atomicData[0] : atomicData
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
    let logistics
    try {
      logistics = parseOptionalProductLogistics(body)
    } catch (validationError) {
      return Response.json(
        {
          error:
            validationError instanceof ProductLogisticsValidationError
              ? validationError.message
              : "Los datos de envío de la variante no son válidos.",
        },
        { status: 400 },
      )
    }
    if (!name || !color || quantity == null || !images) {
      return Response.json(
        { error: "Completá correctamente la variante y sus unidades." },
        { status: 400 },
      )
    }

    const currentResult = await auth.admin
      .from("producto_variantes")
      .select("id")
      .eq("id", variantId)
      .eq("producto_id", productId)
      .maybeSingle()
    if (currentResult.error) {
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
          {
            error: await catalogSkuConflictMessage(
              auth.admin,
              sku ?? skuKey,
              registry.data!,
            ),
          },
          { status: 409 },
        )
      }
    }

    const atomicResult = await auth.admin.rpc(
      "update_product_variant_with_allocation_v2",
      {
        p_product_id: productId,
        p_variant_id: variantId,
        p_name: name,
        p_sku: sku,
        p_color_hex: color,
        p_images: images,
        p_quantity: quantity,
        p_actor_id: auth.user.id,
        p_peso_empaquetado_kg: logistics.peso_empaquetado_kg,
        p_alto_paquete_cm: logistics.alto_paquete_cm,
        p_ancho_paquete_cm: logistics.ancho_paquete_cm,
        p_largo_paquete_cm: logistics.largo_paquete_cm,
      },
    )
    if (!atomicResult.error) {
      const updated = Array.isArray(atomicResult.data)
        ? atomicResult.data[0]
        : atomicResult.data
      return Response.json({ variant: updated })
    }
    const missingMigration =
      /update_product_variant_with_allocation_v2|schema cache|PGRST202/i.test(
        atomicResult.error.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260801102000_product_shipping_data.sql."
          : atomicResult.error.message,
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  const { data: stateData, error: updateError } = await auth.admin.rpc(
    "set_product_variant_state_atomic",
    {
      p_product_id: productId,
      p_variant_id: variantId,
      p_active: body.activo,
      p_actor_id: auth.user.id,
    },
  )

  if (updateError) {
    const missingMigration =
      /set_product_variant_state_atomic|schema cache|PGRST202/i.test(
        updateError.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260808120000_atomic_product_catalog_workflow.sql."
          : updateError.message || "No se pudo cambiar el estado de la variante.",
      },
      { status: missingMigration ? 503 : 409 },
    )
  }
  const updated = Array.isArray(stateData) ? stateData[0] : stateData
  if (!updated) {
    return Response.json(
      { error: "La variante ya no existe." },
      { status: 404 },
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
    const protectedInventory = /unidades vinculadas|movimientos históricos/i.test(
      deleteError.message,
    )
    return Response.json(
      {
        error: isReferenced
          ? "La variante tiene movimientos asociados y no puede eliminarse."
          : deleteError.message || "No se pudo eliminar la variante.",
      },
      { status: isReferenced || protectedInventory ? 409 : 500 },
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
