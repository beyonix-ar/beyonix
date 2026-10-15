import { requireInternalUser } from "@/lib/auth/admin-api"
import type { createAdminClient } from "@/lib/supabase/admin"
import { isReservedProductBarcode } from "@/lib/barcodes/codes"
import { deriveVariantNameFromColor } from "@/lib/products/variant-color"

type AdminClient = ReturnType<typeof createAdminClient>

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

  const sku = optionalText(body?.sku, 120)
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

  let productId = existingProductId
  if (!productId) {
    const name = requiredText(body?.name, 240)
    if (!name) {
      return Response.json(
        { error: "El artículo debe tener un nombre." },
        { status: 400 },
      )
    }
    const productResult = await auth.admin.rpc("ensure_cost_catalog_product", {
      p_name: name,
      p_sku: sku,
    })
    if (productResult.error) {
      const missingMigration =
        /ensure_cost_catalog_product|schema cache|PGRST202/i.test(
          productResult.error.message,
        )
      return Response.json(
        {
          error: missingMigration
            ? "Falta aplicar la migración 20260808120000_atomic_product_catalog_workflow.sql."
            : productResult.error.message,
        },
        { status: missingMigration ? 503 : 409 },
      )
    }
    productId = Number(productResult.data)
  }

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

  // Se pidió un color pero el producto todavía no tiene ninguna variante:
  // crea una nueva, sin stock (lo aporta la compra que se guarda después,
  // que ya viene con su propio movimiento tagueado a esta variante).
  const variantResult = await auth.admin.rpc(
    "create_product_variant_with_allocation_v2",
    {
      p_product_id: productId,
      p_name: colorName ?? deriveVariantNameFromColor(colorHex),
      p_sku: sku,
      p_color_hex: colorHex,
      p_images: [],
      p_quantity: 0,
      p_actor_id: auth.user.id,
      p_peso_empaquetado_kg: null,
      p_alto_paquete_cm: null,
      p_ancho_paquete_cm: null,
      p_largo_paquete_cm: null,
    },
  )
  if (variantResult.error) {
    const missingMigration =
      /create_product_variant_with_allocation_v2|schema cache|PGRST202/i.test(
        variantResult.error.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260801102000_product_shipping_data.sql."
          : variantResult.error.message,
      },
      { status: missingMigration ? 503 : 409 },
    )
  }
  const variant = Array.isArray(variantResult.data)
    ? variantResult.data[0]
    : variantResult.data
  if (!variant) {
    return Response.json(
      { error: "La variante se creó sin una respuesta verificable." },
      { status: 500 },
    )
  }
  const variantId = Number(variant.id)

  const barcodeError = await assignVariantBarcode(
    auth.admin,
    productId,
    variantId,
    barcode,
    generateBarcode,
    auth.user.id,
  )
  if (barcodeError) {
    return Response.json({ error: barcodeError }, { status: 409 })
  }

  return Response.json({ productId, variantId }, { status: 201 })
}
