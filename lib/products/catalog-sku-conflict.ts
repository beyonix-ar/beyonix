import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

interface CatalogSkuOwner {
  product_id: number | string | null
  variant_id: number | string | null
}

export async function catalogSkuConflictMessage(
  admin: SupabaseClient,
  sku: string,
  owner: CatalogSkuOwner,
) {
  const variantId = owner.variant_id == null ? null : Number(owner.variant_id)
  if (variantId) {
    const { data } = await admin
      .from("producto_variantes")
      .select("nombre")
      .eq("id", variantId)
      .maybeSingle()
    return data?.nombre
      ? `El SKU ${sku} ya pertenece a la variante ${data.nombre}.`
      : `El SKU ${sku} ya pertenece a otra variante.`
  }

  const productId = owner.product_id == null ? null : Number(owner.product_id)
  if (productId) {
    const { data } = await admin
      .from("productos")
      .select("nombre")
      .eq("id", productId)
      .maybeSingle()
    return data?.nombre
      ? `El SKU ${sku} ya pertenece al producto ${data.nombre}.`
      : `El SKU ${sku} ya pertenece a otro producto.`
  }

  return `El SKU ${sku} ya está asignado a otro artículo.`
}
