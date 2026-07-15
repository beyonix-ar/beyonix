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
  const { data, error } = await supabase
    .from("productos")
    .insert(payload)
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
  const { data, error } = await supabase.rpc(
    "create_producto_completo",
    {
      p_producto: producto,
      p_imagenes: imagenes,
      p_variantes: variantes,
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
  const { data, error } = await supabase
    .from("productos")
    .update(payload)
    .eq("id", id)
    .select()
    .single()

  if (error) {
    throw error
  }

  return data as SupabaseProducto
}

export async function deleteProducto(
  id: number
) {
  const { data: imagenes } =
    await supabase
      .from(
        "imagenes_producto"
      )
      .select("url")
      .eq(
        "producto_id",
        id
      )

  const paths =
    imagenes
      ?.map((img) =>
        img.url.split(
          "/imagenes-productos/"
        )[1]
      )
      .filter(Boolean) || []

  if (paths.length) {
    await supabase.storage
      .from(
        "imagenes-productos"
      )
      .remove(paths)
  }

  await supabase
    .from(
      "imagenes_producto"
    )
    .delete()
    .eq(
      "producto_id",
      id
    )

  await supabase
    .from(
      "producto_variantes"
    )
    .delete()
    .eq(
      "producto_id",
      id
    )

  const { error } =
    await supabase
      .from("productos")
      .delete()
      .eq("id", id)

  if (error) {
    throw error
  }

  return true
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
