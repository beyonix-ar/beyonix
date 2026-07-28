import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
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
  categoryId?: number | null
  stockFilter?: "todos" | "sin_stock" | "bajo_stock" | "disponible"
  activeFilter?: "todos" | "activos" | "inactivos"
  featuredFilter?: "todos" | "destacados" | "normales"
  lowStockThreshold?: number
  availableStockThreshold?: number
}

export interface ProductosPage {
  productos: SupabaseProducto[]
  total: number
  page: number
  pageSize: number
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

  return attachProductReviewSummaries(productos.map((producto) => ({
    ...producto,
    producto_variantes:
      variantesByProducto[
        producto.id
      ] || [],
  })))
}

export async function getProductosPage({
  page = 1,
  pageSize = 25,
  search = "",
  categoryId = null,
  stockFilter = "todos",
  activeFilter = "todos",
  featuredFilter = "todos",
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
    query = query.or(
      `nombre.ilike.%${normalizedSearch}%,slug.ilike.%${normalizedSearch}%,sku.ilike.%${normalizedSearch}%`,
    )
  }
  if (categoryId) query = query.eq("categoria_id", categoryId)
  if (activeFilter === "activos") query = query.eq("activo", true)
  if (activeFilter === "inactivos") query = query.eq("activo", false)
  if (featuredFilter === "destacados") query = query.eq("destacado", true)
  if (featuredFilter === "normales") query = query.eq("destacado", false)
  if (stockFilter === "sin_stock") query = query.lte("stock", 0)
  if (stockFilter === "bajo_stock") {
    query = query.gt("stock", 0).lte("stock", lowStockThreshold)
  }
  if (stockFilter === "disponible") {
    query = query.gte("stock", availableStockThreshold)
  }

  const { data, error, count } = await query
    .order("id", { ascending: false })
    .range(from, to)

  if (error) throw error

  const productos = await attachProductReviewSummaries(
    ((data ?? []) as SupabaseProducto[]).map((producto) => ({
      ...producto,
      producto_variantes: [...(producto.producto_variantes ?? [])].sort(
        (a, b) => a.orden - b.orden || a.id - b.id,
      ),
    })),
  )

  return {
    productos,
    total: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  }
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

  return data as SupabaseProducto
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
  return updateProducto(producto.id, {
    activo: !producto.activo,
  })
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
