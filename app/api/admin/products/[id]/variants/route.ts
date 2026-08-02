import { requireInternalUser } from "@/lib/auth/admin-api"
import {
  parseOptionalProductLogistics,
  ProductLogisticsValidationError,
} from "@/lib/shipping/logistics-validation"

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
  let logistics
  try {
    logistics = parseOptionalProductLogistics(body ?? {})
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

  if (!productId || !name || !color || quantity == null || !images) {
    return Response.json(
      { error: "Completá correctamente la variante y sus unidades." },
      { status: 400 },
    )
  }

  const productResult = await auth.admin
    .from("productos")
    .select("id, sku, activo")
    .eq("id", productId)
    .maybeSingle()

  if (productResult.error) {
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
    "create_product_variant_with_allocation_v2",
    {
      p_product_id: productId,
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
  const missingMigration =
    /create_product_variant_with_allocation_v2|schema cache|PGRST202/i.test(
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
