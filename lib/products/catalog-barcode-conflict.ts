import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

interface BarcodeTarget {
  productId: number
  variantId: number
}

interface BarcodeOwner {
  product_id: number | string | null
  variant_id: number | string | null
}

async function describeOwner(admin: SupabaseClient, owner: BarcodeOwner) {
  const variantId = owner.variant_id == null ? null : Number(owner.variant_id)
  if (variantId) {
    const { data } = await admin
      .from("producto_variantes")
      .select("nombre, productos(nombre)")
      .eq("id", variantId)
      .maybeSingle()
    const variant = data as { nombre?: string | null; productos?: { nombre?: string | null } | null } | null
    const productName = variant?.productos?.nombre?.trim()
    const variantName = variant?.nombre?.trim()
    if (productName && variantName) return `${productName} · ${variantName}`
    return variantName ? `la variante ${variantName}` : "otra variante"
  }

  const productId = owner.product_id == null ? null : Number(owner.product_id)
  if (productId) {
    const { data } = await admin
      .from("productos")
      .select("nombre")
      .eq("id", productId)
      .maybeSingle()
    return data?.nombre?.trim() || "otro producto"
  }

  return "otro artículo"
}

/**
 * Mismo criterio que la base (catalog_barcode_registry +
 * catalog_barcode_aliases, normalizado con btrim): devuelve el mensaje de
 * conflicto indicando dónde está usado el código, o null si la variante lo
 * puede tomar. Es sólo para dar un mensaje claro: la unicidad la sigue
 * garantizando la base aunque dos guardados compitan.
 */
export async function catalogBarcodeConflictMessage(
  admin: SupabaseClient,
  barcode: string,
  target: BarcodeTarget,
): Promise<string | null> {
  const normalized = barcode.trim()
  if (!normalized) return null

  const registry = await admin
    .from("catalog_barcode_registry")
    .select("product_id, variant_id")
    .eq("normalized_barcode", normalized)
    .maybeSingle()
  if (registry.error) throw new Error("No se pudo validar el código de barra.")
  const owner = registry.data as BarcodeOwner | null
  if (owner) {
    const ownVariant = Number(owner.variant_id) === target.variantId
    // Código cargado a nivel del mismo producto: el trigger lo pasa a la variante.
    const ownProduct = owner.variant_id == null && Number(owner.product_id) === target.productId
    if (!ownVariant && !ownProduct) {
      return `El código de barra ${normalized} ya está asignado a ${await describeOwner(admin, owner)}. Usá un código distinto para esta variante.`
    }
  }

  const alias = await admin
    .from("catalog_barcode_aliases")
    .select("product_id, variant_id")
    .eq("normalized_barcode", normalized)
    .maybeSingle()
  if (alias.error) throw new Error("No se pudo validar el código de barra.")
  if (alias.data) {
    return `El código de barra ${normalized} es un código de grupo de ${await describeOwner(admin, { product_id: alias.data.product_id, variant_id: null })} (identifica a varios colores). Usá un código distinto para esta variante.`
  }

  return null
}
