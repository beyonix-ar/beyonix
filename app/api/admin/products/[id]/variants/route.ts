import { requireInternalUser } from "@/lib/auth/admin-api"

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function nonNegativeInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
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

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const productId = positiveInteger((await context.params).id)
  if (!productId) {
    return Response.json(
      { error: "El producto indicado no es válido." },
      { status: 400 },
    )
  }

  const { data, error } = await auth.admin
    .from("producto_variantes")
    .select("*")
    .eq("producto_id", productId)
    .order("orden", { ascending: true })
    .order("id", { ascending: true })

  if (error) {
    return Response.json(
      { error: "No se pudieron cargar las variantes del producto." },
      { status: 500 },
    )
  }

  return Response.json({ variants: data ?? [] })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const productId = positiveInteger((await context.params).id)
  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null
  const name = requiredText(body?.name, 160)
  const sku = optionalText(body?.sku, 120)
  const color = validColor(body?.color)
  const quantity = nonNegativeInteger(body?.quantity)
  const images = imageUrls(body?.images)

  if (!productId || !name || !color || quantity == null || !images) {
    return Response.json(
      { error: "Completá correctamente la variante y sus unidades." },
      { status: 400 },
    )
  }

  const [productResult, variantsResult, allocationsResult] = await Promise.all([
    auth.admin
      .from("productos")
      .select("id, sku, activo")
      .eq("id", productId)
      .maybeSingle(),
    auth.admin
      .from("producto_variantes")
      .select("id, sku, orden")
      .eq("producto_id", productId)
      .order("orden", { ascending: true })
      .order("id", { ascending: true }),
    auth.admin
      .from("inventory_variant_allocations")
      .select("variant_id, quantity")
      .eq("product_id", productId),
  ])

  if (productResult.error || variantsResult.error || allocationsResult.error) {
    return Response.json(
      { error: "No se pudo preparar la creación de la variante." },
      { status: 500 },
    )
  }
  if (!productResult.data) {
    return Response.json(
      { error: "El producto ya no existe." },
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
    const ownedByCurrentSimpleProduct =
      Number(registry.data?.product_id) === productId &&
      registry.data?.variant_id == null
    if (registry.data && !ownedByCurrentSimpleProduct) {
      return Response.json(
        { error: `El SKU ${sku} ya está asignado a otro artículo.` },
        { status: 409 },
      )
    }
  }

  const atomicResult = await auth.admin.rpc(
    "create_product_variant_with_allocation",
    {
      p_product_id: productId,
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
    /create_product_variant_with_allocation|schema cache|PGRST202/i.test(
      atomicResult.error.message,
    )

  if (!atomicResult.error) {
    const atomicVariant = Array.isArray(atomicResult.data)
      ? atomicResult.data[0]
      : atomicResult.data
    if (!atomicVariant) {
      return Response.json(
        { error: "La variante se creó sin una respuesta verificable." },
        { status: 500 },
      )
    }
    return Response.json({ variant: atomicVariant }, { status: 201 })
  }
  if (!atomicFunctionMissing) {
    return Response.json(
      { error: atomicResult.error.message },
      { status: 409 },
    )
  }

  // Compatibilidad temporal hasta aplicar la migración 106. Cada escritura
  // tiene compensación y la distribución final conserva el bloqueo de stock.
  const previousSku = productResult.data.sku
  const { data: created, error: createError } = await auth.admin
    .from("producto_variantes")
    .insert({
      producto_id: productId,
      nombre: name,
      sku,
      color_hex: color,
      imagenes: images,
      activo: productResult.data.activo === true,
      orden: (variantsResult.data?.length ?? 0) + 1,
    })
    .select("*")
    .single()

  if (createError || !created) {
    return Response.json(
      {
        error:
          createError?.message || "No se pudo crear la variante en el catálogo.",
      },
      { status: 400 },
    )
  }

  const rollback = async () => {
    await auth.admin
      .from("producto_variantes")
      .delete()
      .eq("id", created.id)
      .eq("producto_id", productId)
    await auth.admin
      .from("productos")
      .update({ sku: previousSku })
      .eq("id", productId)
  }

  const { error: productSkuError } = await auth.admin
    .from("productos")
    .update({ sku: null })
    .eq("id", productId)

  if (productSkuError) {
    await rollback()
    return Response.json(
      { error: "No se pudo transferir el SKU principal a la variante." },
      { status: 500 },
    )
  }

  const allocations = [
    ...(allocationsResult.data ?? []).map((allocation) => ({
      variant_id: Number(allocation.variant_id),
      quantity: Number(allocation.quantity),
    })),
    {
      variant_id: Number(created.id),
      quantity,
    },
  ]
  const { error: allocationError } = await auth.admin.rpc(
    "set_product_variant_allocations",
    {
      p_product_id: productId,
      p_allocations: allocations,
      p_actor_id: auth.user.id,
    },
  )

  if (allocationError) {
    await rollback()
    return Response.json(
      {
        error:
          allocationError.message ||
          "No se pudo asignar el inventario a la variante.",
      },
      { status: 409 },
    )
  }

  return Response.json({ variant: created }, { status: 201 })
}
