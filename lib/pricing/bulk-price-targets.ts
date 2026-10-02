import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export type BulkPriceScope = "store" | "category" | "product"

export interface BulkTargetItem {
  type: "category" | "product"
  label: string
  url: string
}

export interface BulkTargetProduct {
  id: number
  nombre: string
  slug: string
  precio: number
  precio_anterior: number | null
  descuento: number | null
  categoria_id: number | null
  promo_event_id: string | null
}

export const BULK_TARGET_PRODUCT_COLUMNS =
  "id, nombre, slug, precio, precio_anterior, descuento, categoria_id, promo_event_id"

function slugsFrom(items: readonly BulkTargetItem[], prefix: string) {
  return items.map((item) => (item.url.startsWith(prefix) ? item.url.slice(prefix.length) : "")).filter(Boolean)
}

/** Ítems de alcance válidos (categoría o producto con URL interna). */
export function normalizeBulkTargetItems(value: unknown): BulkTargetItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    const type = typeof source.type === "string" ? source.type.trim() : ""
    const label = typeof source.label === "string" ? source.label.trim() : ""
    const url = typeof source.url === "string" ? source.url.trim() : ""
    return (type === "category" || type === "product") && label && url.startsWith("/")
      ? [{ type, label, url } as BulkTargetItem]
      : []
  })
}

/**
 * Productos alcanzados por un cambio masivo (toda la tienda, categorías o
 * selección): la MISMA resolución para el Editor masivo y los eventos.
 */
export async function resolveBulkTargetProducts(
  admin: AdminClient,
  scope: BulkPriceScope,
  targetItems: readonly BulkTargetItem[],
): Promise<{ products: BulkTargetProduct[] } | { error: string; status: number }> {
  let query = admin.from("productos").select(BULK_TARGET_PRODUCT_COLUMNS)

  if (scope === "product") {
    const slugs = slugsFrom(targetItems, "/productos/")
    if (!slugs.length) return { error: "Agregá al menos un producto.", status: 400 }
    query = query.in("slug", slugs)
  } else if (scope === "category") {
    const categorySlugs = slugsFrom(targetItems, "/categorias/")
    if (!categorySlugs.length) return { error: "Agregá al menos una categoría.", status: 400 }
    const { data: categories, error } = await admin.from("categorias").select("id").in("slug", categorySlugs)
    if (error) return { error: "No se pudieron leer las categorías.", status: 500 }
    const categoryIds = ((categories ?? []) as Array<{ id: number }>).map((category) => category.id)
    if (!categoryIds.length) return { error: "No encontramos esas categorías.", status: 404 }
    query = query.in("categoria_id", categoryIds)
  } else if (scope !== "store") {
    return { error: "Elegí el alcance de productos.", status: 400 }
  }

  const { data, error } = await query.order("id")
  if (error) return { error: "No se pudieron leer los productos.", status: 500 }
  return { products: ((data ?? []) as unknown as BulkTargetProduct[]).map((product) => ({ ...product, precio: Number(product.precio) })) }
}
