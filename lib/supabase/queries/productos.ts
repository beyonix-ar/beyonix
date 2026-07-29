import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
  SupabaseConditionedStock,
  SupabaseProducto,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"
import { attachProductReviewSummaries } from "@/lib/reviews/product-review-summary"

export interface ProductoPayload {
  nombre: string
  slug: string
  descripcion?: string | null
  precio: number
  precio_anterior?: number | null
  descuento?: number | null
  cuotas_sin_interes?: boolean
  cuotas_maximas?: 3 | 6 | null
  promo_event_id?: string | null
  promo_original_precio?: number | null
  promo_original_precio_anterior?: number | null
  promo_original_descuento?: number | null
  promo_original_cuotas_sin_interes?: boolean | null
  promo_original_cuotas_maximas?: 3 | 6 | null
  stock?: number
  categoria_id?: number | null
  destacado?: boolean
  activo?: boolean
  imagen_principal?: string | null
  video_url?: string | null
}

interface ProductoCompletoImagenPayload {
  url: string
  orden: number
}

interface ProductoCompletoVariantePayload {
  nombre: string
  sku?: string | null
  color_hex: string
  stock?: number | null
  imagenes?: string[]
  activo?: boolean
  orden?: number
}

interface ProductoCompletoEspecificacionPayload {
  icono: string
  texto: string
  orden?: number
  activo?: boolean
}

export interface ProductoCompletoPayload {
  producto: ProductoPayload
  imagenes?: ProductoCompletoImagenPayload[]
  variantes?: ProductoCompletoVariantePayload[]
  especificaciones?: ProductoCompletoEspecificacionPayload[]
}

const PRODUCTO_SELECT = `
  *,
  categorias(*),
  imagenes_producto(*),
  producto_variantes(*),
  producto_especificaciones(*)
`

export interface ProductosPageOptions {
  page?: number
  pageSize?: number
  search?: string
  colorSearch?: string
  categoryId?: number | null
  stockFilter?:
    | "todos"
    | "sin_stock"
    | "bajo_stock"
    | "disponible"
    | "mayor_que"
    | "menor_que"
    | "entre"
  stockFrom?: number | null
  stockTo?: number | null
  activeFilter?: "todos" | "activos" | "inactivos"
  featuredFilter?: "todos" | "destacados" | "normales"
  skuFilter?: "todos" | "con_sku" | "sin_sku"
  sortBy?: "nombre" | "stock" | "sku" | "color"
  sortDirection?: "asc" | "desc"
  lowStockThreshold?: number
  availableStockThreshold?: number
}

export interface ProductosPage {
  productos: SupabaseProducto[]
  total: number
  page: number
  pageSize: number
}

export interface ProductColorOption {
  value: string
  label: string
  hex: string
}

export interface CategoryProductStats {
  articulos: number
  stock: number
}

function normalizeSlug(
  value: string | null | undefined
) {
  return (value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

async function attachConditionedStock(productos: SupabaseProducto[]) {
  const productIds = productos.map((producto) => producto.id)
  if (!productIds.length) return productos

  let { data, error } = await supabase
    .from("inventory_return_movements")
    .select(
      "id, product_id, variant_id, discounted_quantity, discount_percent, discount_reason, non_sellable_quantity, non_sellable_reason, conditioned_active, approved_at",
    )
    .in("product_id", productIds)
    .gt("discounted_quantity", 0)
    .order("approved_at", { ascending: false })

  if (
    error &&
    /discount_reason|non_sellable_reason|conditioned_active|schema cache/i.test(
      error.message,
    )
  ) {
    const fallback = await supabase
      .from("inventory_return_movements")
      .select(
        "id, product_id, variant_id, discounted_quantity, discount_percent, non_sellable_quantity, approved_at",
      )
      .in("product_id", productIds)
      .gt("discounted_quantity", 0)
      .order("approved_at", { ascending: false })

    data = fallback.data?.map((item) => ({
      ...item,
      discount_reason: null,
      non_sellable_reason: null,
      conditioned_active: false,
    })) ?? null
    error = fallback.error
  }

  if (error) throw error

  const conditionedByProduct = new Map<number, SupabaseConditionedStock[]>()
  for (const item of data ?? []) {
    const productId = Number(item.product_id)
    const quantity = Number(item.discounted_quantity ?? 0)
    const discountPercent = Number(item.discount_percent ?? 0)
    if (!productId || quantity <= 0 || discountPercent <= 0) continue

    const conditionedItem: SupabaseConditionedStock = {
      id: String(item.id),
      product_id: productId,
      variant_id:
        item.variant_id == null ? null : Number(item.variant_id),
      quantity,
      discount_percent: discountPercent,
      reason:
        typeof item.discount_reason === "string"
          ? item.discount_reason
          : null,
      non_sellable_quantity: Number(item.non_sellable_quantity ?? 0),
      non_sellable_reason:
        typeof item.non_sellable_reason === "string"
          ? item.non_sellable_reason
          : null,
      active: item.conditioned_active === true,
      approved_at: String(item.approved_at),
    }
    conditionedByProduct.set(productId, [
      ...(conditionedByProduct.get(productId) ?? []),
      conditionedItem,
    ])
  }

  return productos.map((producto) => ({
    ...producto,
    conditioned_stock: conditionedByProduct.get(producto.id) ?? [],
  }))
}

// ─────────────────────────────────────────────────────────────
// Productos
// ─────────────────────────────────────────────────────────────

export async function getProductos() {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .order("id", {
      ascending: false,
    })

  if (error) {
    throw error
  }

  const productos =
    (data || []) as SupabaseProducto[]

  const {
    data: variantes,
    error: variantesError,
  } = await supabase
    .from("producto_variantes")
    .select("*")
    .order("orden", {
      ascending: true,
    })
    .order("id", {
      ascending: true,
    })

  if (variantesError) {
    throw variantesError
  }

  const variantesByProducto =
    (
      variantes ||
      []
    ).reduce<
      Record<
        number,
        SupabaseProductoVariante[]
      >
    >((acc, variante) => {
      const item =
        variante as SupabaseProductoVariante

      acc[item.producto_id] = [
        ...(acc[item.producto_id] || []),
        item,
      ]

      return acc
    }, {})

  return attachProductReviewSummaries(
    await attachConditionedStock(productos.map((producto) => ({
      ...producto,
      producto_variantes:
        variantesByProducto[
          producto.id
        ] || [],
    }))),
  )
}

export async function getProductosPage({
  page = 1,
  pageSize = 25,
  search = "",
  colorSearch = "",
  categoryId = null,
  stockFilter = "todos",
  stockFrom = null,
  stockTo = null,
  activeFilter = "todos",
  featuredFilter = "todos",
  skuFilter = "todos",
  sortBy = "nombre",
  sortDirection = "asc",
  lowStockThreshold = 5,
  availableStockThreshold = 6,
}: ProductosPageOptions = {}): Promise<ProductosPage> {
  const safePage = Math.max(1, Math.floor(page))
  const safePageSize = Math.min(100, Math.max(10, Math.floor(pageSize)))
  const from = (safePage - 1) * safePageSize
  const to = from + safePageSize - 1
  let query = supabase
    .from("productos")
    .select(PRODUCTO_SELECT, { count: "exact" })

  const normalizedSearch = search.trim().replace(/[%(),]/g, " ")
  if (normalizedSearch) {
    const { data: matchingVariants, error: variantsError } = await supabase
      .from("producto_variantes")
      .select("producto_id")
      .ilike("sku", `%${normalizedSearch}%`)

    if (variantsError) throw variantsError

    const variantProductIds = [
      ...new Set((matchingVariants ?? []).map((item) => item.producto_id)),
    ]
    const variantSearchClause = variantProductIds.length
      ? `,id.in.(${variantProductIds.join(",")})`
      : ""

    query = query.or(
      `nombre.ilike.%${normalizedSearch}%,sku.ilike.%${normalizedSearch}%${variantSearchClause}`,
    )
  }
  const normalizedColor = colorSearch.trim().replace(/[%(),]/g, " ")
  if (normalizedColor) {
    const { data: matchingVariants, error: variantsError } = await supabase
      .from("producto_variantes")
      .select("producto_id")
      .or(
        `nombre.ilike.%${normalizedColor}%,color_hex.ilike.%${normalizedColor}%`,
      )

    if (variantsError) throw variantsError

    const productIds = [
      ...new Set((matchingVariants ?? []).map((item) => item.producto_id)),
    ]

    if (!productIds.length) {
      return {
        productos: [],
        total: 0,
        page: safePage,
        pageSize: safePageSize,
      }
    }

    query = query.in("id", productIds)
  }
  if (categoryId) query = query.eq("categoria_id", categoryId)
  if (activeFilter === "activos") query = query.eq("activo", true)
  if (activeFilter === "inactivos") query = query.eq("activo", false)
  if (featuredFilter === "destacados") query = query.eq("destacado", true)
  if (featuredFilter === "normales") query = query.eq("destacado", false)
  if (skuFilter !== "todos") {
    const { data: variantsWithSku, error: variantsError } = await supabase
      .from("producto_variantes")
      .select("producto_id")
      .not("sku", "is", null)

    if (variantsError) throw variantsError

    const productIdsWithVariantSku = [
      ...new Set((variantsWithSku ?? []).map((item) => item.producto_id)),
    ]

    if (skuFilter === "con_sku") {
      const variantSkuClause = productIdsWithVariantSku.length
        ? `,id.in.(${productIdsWithVariantSku.join(",")})`
        : ""
      query = query.or(`sku.not.is.null${variantSkuClause}`)
    } else {
      query = query.is("sku", null)
      if (productIdsWithVariantSku.length) {
        query = query.not(
          "id",
          "in",
          `(${productIdsWithVariantSku.join(",")})`,
        )
      }
    }
  }
  if (stockFilter === "sin_stock") query = query.lte("stock", 0)
  if (stockFilter === "bajo_stock") {
    query = query.gt("stock", 0).lte("stock", lowStockThreshold)
  }
  if (stockFilter === "disponible") {
    query = query.gte("stock", availableStockThreshold)
  }
  if (stockFilter === "mayor_que" && stockFrom !== null) {
    query = query.gt("stock", stockFrom)
  }
  if (stockFilter === "menor_que" && stockTo !== null) {
    query = query.lt("stock", stockTo)
  }
  if (stockFilter === "entre") {
    if (stockFrom !== null) query = query.gte("stock", stockFrom)
    if (stockTo !== null) query = query.lte("stock", stockTo)
  }

  const { data, error, count } = await query
    .order(sortBy === "color" ? "id" : sortBy, {
      ascending: sortDirection === "asc",
      nullsFirst: false,
    })
    .order("id", { ascending: true })
    .range(from, to)

  if (error) throw error

  const productos = await attachProductReviewSummaries(
    await attachConditionedStock(
      ((data ?? []) as SupabaseProducto[]).map((producto) => ({
        ...producto,
        producto_variantes: [...(producto.producto_variantes ?? [])].sort(
          (a, b) => a.orden - b.orden || a.id - b.id,
        ),
      })),
    ),
  )

  return {
    productos,
    total: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  }
}

export async function getProductColorOptions(): Promise<ProductColorOption[]> {
  const { data, error } = await supabase
    .from("producto_variantes")
    .select("nombre, color_hex")
    .order("nombre", { ascending: true })

  if (error) throw error

  const colors = new Map<string, ProductColorOption>()

  for (const variant of data ?? []) {
    const label = variant.nombre?.trim()
    const hex = variant.color_hex?.trim()
    if (!label || !hex) continue

    const key = hex.toLocaleLowerCase("es")
    if (!colors.has(key)) {
      colors.set(key, { value: hex, label, hex })
    }
  }

  return [...colors.values()].sort((left, right) =>
    left.label.localeCompare(right.label, "es", { sensitivity: "base" }),
  )
}

export async function getCategoryProductStats() {
  const { data, error } = await supabase.rpc("get_admin_category_product_stats")
  if (error) throw error

  return new Map<number, CategoryProductStats>(
    ((data ?? []) as Array<{
      category_id: number
      product_count: number
      stock_total: number
    }>).map((row) => [
      Number(row.category_id),
      {
        articulos: Number(row.product_count ?? 0),
        stock: Number(row.stock_total ?? 0),
      },
    ]),
  )
}

export async function getProductoById(
  id: number
) {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .eq("id", id)
    .single()

  if (error) {
    throw error
  }

  const [product] = await attachProductReviewSummaries([
    data as SupabaseProducto,
  ])

  return product
}

export async function getProductoBySlug(
  slug: string
) {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .eq("slug", slug)
    .single()

  if (error) {
    throw error
  }

  const [product] = await attachProductReviewSummaries([
    data as SupabaseProducto,
  ])

  return product
}

export async function getFeaturedProductos() {
  const { data, error } = await supabase
    .from("productos")
    .select(PRODUCTO_SELECT)
    .eq("destacado", true)
    .eq("activo", true)
    .order("id", {
      ascending: false,
    })

  if (error) {
    throw error
  }

  return attachProductReviewSummaries((data || []) as SupabaseProducto[])
}

// ─────────────────────────────────────────────────────────────
// CRUD
// ─────────────────────────────────────────────────────────────

export async function createProducto(
  payload: ProductoPayload
) {
  const catalogPayload = { ...payload }
  delete catalogPayload.stock
  const { data, error } = await supabase
    .from("productos")
    .insert(catalogPayload)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

export async function createProductoCompleto({
  producto,
  imagenes = [],
  variantes = [],
  especificaciones = [],
}: ProductoCompletoPayload) {
  const catalogProduct = { ...producto }
  delete catalogProduct.stock
  const { data, error } = await supabase.rpc(
    "create_producto_completo",
    {
      p_producto: catalogProduct,
      p_imagenes: imagenes,
      p_variantes: variantes.map((variant) => {
        const catalogVariant = { ...variant }
        delete catalogVariant.stock
        return catalogVariant
      }),
      p_especificaciones: especificaciones,
    }
  )

  if (error) {
    throw error
  }

  const created = data as SupabaseProducto
  const variantsWithSku = variantes.filter((variant) => variant.sku?.trim())

  if (variantsWithSku.length) {
    const { data: createdVariants, error: variantsError } = await supabase
      .from("producto_variantes")
      .select("id, orden")
      .eq("producto_id", created.id)

    if (variantsError) throw variantsError

    for (const variant of variantsWithSku) {
      const createdVariant = createdVariants?.find(
        (item) => item.orden === (variant.orden ?? 1),
      )
      if (!createdVariant) continue

      const { error: skuError } = await supabase
        .from("producto_variantes")
        .update({ sku: variant.sku?.trim() || null })
        .eq("id", createdVariant.id)

      if (skuError) throw skuError
    }
  }

  return created
}

export async function updateProducto(
  id: number,
  payload: Partial<ProductoPayload>
) {
  const catalogPayload = { ...payload }
  delete catalogPayload.stock
  const { data, error } = await supabase
    .from("productos")
    .update(catalogPayload)
    .eq("id", id)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

async function conditionedStockRequest(
  id: string,
  init: RequestInit,
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) {
    throw new Error("La sesión administrativa venció.")
  }

  const response = await fetch(
    `/api/admin/conditioned-stock/${encodeURIComponent(id)}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      cache: "no-store",
    },
  )
  const payload = (await response.json().catch(() => null)) as
    | {
        item?: {
          id: string
          product_id: number
          variant_id: number | null
          discounted_quantity: number
          discount_percent: number
          discount_reason: string | null
          non_sellable_quantity: number
          non_sellable_reason: string | null
          conditioned_active: boolean
          approved_at: string
        }
        deleted?: boolean
        error?: string
      }
    | null
  if (!response.ok) {
    throw new Error(
      payload?.error || "No se pudo actualizar la unidad con descuento.",
    )
  }
  return payload
}

export async function updateConditionedStock(
  id: string,
  payload: {
    active?: boolean
    discountPercent?: number
    discountReason?: string
    nonSellableReason?: string
  },
) {
  const response = await conditionedStockRequest(id, {
    method: "PATCH",
    body: JSON.stringify(payload),
  })
  if (!response?.item) {
    throw new Error("No se recibió la unidad actualizada.")
  }
  return {
    id: response.item.id,
    product_id: Number(response.item.product_id),
    variant_id:
      response.item.variant_id == null
        ? null
        : Number(response.item.variant_id),
    quantity: Number(response.item.discounted_quantity),
    discount_percent: Number(response.item.discount_percent),
    reason: response.item.discount_reason,
    non_sellable_quantity: Number(response.item.non_sellable_quantity),
    non_sellable_reason: response.item.non_sellable_reason,
    active: response.item.conditioned_active === true,
    approved_at: response.item.approved_at,
  } satisfies SupabaseConditionedStock
}

export async function deleteConditionedStock(id: string) {
  await conditionedStockRequest(id, { method: "DELETE" })
}

export async function deleteProducto(
  id: number,
  options: { force?: boolean } = {},
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error(
      "La sesión administrativa venció. Volvé a iniciar sesión.",
    )
  }

  const query = options.force ? "?force=true" : ""
  const response = await fetch(`/api/admin/products/${id}${query}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => null)) as
    | {
        mode?: "deleted" | "archived"
        message?: string
        error?: string
      }
    | null

  if (!response.ok || !payload?.mode) {
    throw new Error(
      payload?.error || "No se pudo eliminar el producto.",
    )
  }

  return {
    mode: payload.mode,
    message:
      payload.message ||
      (payload.mode === "deleted"
        ? "Producto eliminado."
        : "Producto archivado."),
  }
}

export async function toggleProductoActivo(
  producto: SupabaseProducto
) {
  const nextActive = !producto.activo

  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error(
      "La sesión administrativa venció. Volvé a iniciar sesión.",
    )
  }

  const response = await fetch(`/api/admin/products/${producto.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ activo: nextActive }),
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => null)) as
    | {
        product?: SupabaseProducto
        error?: string
      }
    | null

  if (!response.ok || !payload?.product) {
    throw new Error(
      payload?.error || "No se pudo cambiar el estado del producto.",
    )
  }

  return payload.product
}

// ─────────────────────────────────────────────────────────────
// Categorías
// ─────────────────────────────────────────────────────────────

export async function getCategorias() {
  const { data, error } = await supabase
    .from("categorias")
    .select("*")
    .order("nombre")

  if (error) {
    throw error
  }

  return (data || []) as SupabaseCategoria[]
}

export async function getCategoriaBySlug(
  slug: string | null | undefined
) {
  const normalizedSlug =
    normalizeSlug(slug)

  if (!normalizedSlug) {
    return null
  }

  const { data, error } = await supabase
    .from("categorias")
    .select("*")

  if (error) {
    throw error
  }

  const categorias =
    (data || []) as SupabaseCategoria[]

  return (
    categorias.find(
      (categoria) =>
        normalizeSlug(categoria.slug) ===
          normalizedSlug ||
        normalizeSlug(categoria.nombre) ===
          normalizedSlug
    ) || null
  )
}
