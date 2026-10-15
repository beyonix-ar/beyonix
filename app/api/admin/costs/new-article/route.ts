import { requireInternalUser } from "@/lib/auth/admin-api"
import type { createAdminClient } from "@/lib/supabase/admin"
import { isReservedProductBarcode } from "@/lib/barcodes/codes"
import { deriveVariantNameFromColor } from "@/lib/products/variant-color"

type AdminClient = ReturnType<typeof createAdminClient>

const NEW_VARIANT_WITH_PURCHASE_MESSAGE =
  "La variante nueva se crea junto con su compra: completá cantidad y costo y guardá la compra."

// La variante es la fuente de verdad del código: Compras sólo completa un
// código faltante (escaneado o BEYONIX generado) y nunca pisa uno existente.
async function assignVariantBarcode(
  admin: AdminClient,
  productId: number,
  variantId: number,
  barcode: string | null,
  generate: boolean,
  actorId: string,
) {
  if (!barcode && !generate) return null
  const current = await admin
    .from("producto_variantes")
    .select("codigo_barra")
    .eq("id", variantId)
    .eq("producto_id", productId)
    .maybeSingle()
  if (current.error || !current.data) return "No se pudo validar el código de la variante."
  const existing = current.data.codigo_barra?.trim() || null
  if (existing) {
    return barcode && barcode !== existing
      ? `La variante ya tiene el código ${existing}. Cambialo desde Productos.`
      : null
  }
  if (barcode) {
    const update = await admin
      .from("producto_variantes")
      .update({ codigo_barra: barcode })
      .eq("id", variantId)
      .or("codigo_barra.is.null,codigo_barra.eq.")
    return update.error?.message ?? null
  }
  const generated = await admin.rpc("generate_beyonix_variant_barcode", {
    p_product_id: productId,
    p_variant_id: variantId,
    p_actor_id: actorId,
  })
  return generated.error?.message ?? null
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

function validColor(value: unknown) {
  const normalized = requiredText(value, 7)
  return normalized && /^#[0-9A-F]{6}$/i.test(normalized)
    ? normalized.toUpperCase()
    : null
}

function positiveInteger(value: unknown) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function POST(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const body = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null

  const barcode = optionalText(body?.barcode, 64)
  const generateBarcode = body?.generateBarcode === true
  const colorHex = body?.colorHex ? validColor(body.colorHex) : null
  const colorName = optionalText(body?.colorName, 160)
  const existingProductId = body?.productId
    ? positiveInteger(body.productId)
    : null
  const existingVariantId = body?.variantId
    ? positiveInteger(body.variantId)
    : null

  if (body?.colorHex && !colorHex) {
    return Response.json(
      { error: "El color elegido no es válido." },
      { status: 400 },
    )
  }
  if (barcode && isReservedProductBarcode(barcode)) {
    return Response.json(
      { error: "Ese código pertenece a un bulto o lote de envío, no a un artículo." },
      { status: 400 },
    )
  }
  if (barcode && generateBarcode) {
    return Response.json(
      { error: "Elegí escanear un código o generar uno BEYONIX, no ambos." },
      { status: 400 },
    )
  }

  // Artículos y variantes nuevos nacen SÓLO junto con su compra
  // (POST /api/admin/costs con newVariant, una sola transacción). Este
  // endpoint ya no crea nada: sólo completa datos de lo que ya existe.
  if (!existingProductId) {
    return Response.json(
      { error: NEW_VARIANT_WITH_PURCHASE_MESSAGE },
      { status: 409 },
    )
  }
  const productId = existingProductId
  // Editando una variante que ya existe: solo actualiza su color/nombre/
  // código de barra, nunca mueve stock (eso lo maneja la compra en sí).
  if (existingVariantId) {
    if (colorHex) {
      const metadataResult = await auth.admin.rpc(
        "update_product_variant_metadata_atomic",
        {
          p_product_id: productId,
          p_variant_id: existingVariantId,
          p_metadata: {
            nombre: colorName ?? deriveVariantNameFromColor(colorHex),
            color_hex: colorHex,
          },
          p_actor_id: auth.user.id,
        },
      )
      if (metadataResult.error) {
        return Response.json(
          { error: metadataResult.error.message },
          { status: 409 },
        )
      }
    }
    const barcodeError = await assignVariantBarcode(
      auth.admin,
      productId,
      existingVariantId,
      barcode,
      generateBarcode,
      auth.user.id,
    )
    if (barcodeError) {
      return Response.json({ error: barcodeError }, { status: 409 })
    }
    return Response.json(
      { productId, variantId: existingVariantId },
      { status: 200 },
    )
  }

  if (!colorHex) {
    if (generateBarcode) {
      return Response.json(
        { error: "Elegí un color: el código BEYONIX se asigna a una variante." },
        { status: 400 },
      )
    }
    if (!barcode) return Response.json({ productId, variantId: null }, { status: 200 })
    const barcodeUpdate = await auth.admin
      .from("productos")
      .update({ codigo_barra: barcode })
      .eq("id", productId)
      .or("codigo_barra.is.null,codigo_barra.eq.")
    if (barcodeUpdate.error) {
      return Response.json(
        { error: barcodeUpdate.error.message },
        { status: 409 },
      )
    }
    return Response.json({ productId, variantId: null }, { status: 200 })
  }

  // Un color nuevo de un producto existente es una variante nueva: se crea
  // únicamente junto con su compra.
  return Response.json(
    { error: NEW_VARIANT_WITH_PURCHASE_MESSAGE },
    { status: 409 },
  )
}