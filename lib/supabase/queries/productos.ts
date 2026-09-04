import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseCategoria,
  SupabaseConditionedStock,
  SupabaseProducto,
  SupabaseProductoVariante,
} from "@/lib/supabase/types"
import {
  calculateInventoryStock,
  classifyReturnStock,
} from "@/lib/inventory/stock-metrics"
import { attachProductReviewSummaries } from "@/lib/reviews/product-review-summary"
import { getAdminProductoVariantes } from "@/lib/supabase/queries/producto-variantes"

export interface ProductoPayload {
  nombre: string
  sku?: string | null
  slug: string
  descripcion?: string | null
  precio: number
  precio_anterior?: number | null
  descuento?: number | null
  cuotas_2_habilitadas?: boolean
  cuotas_3_habilitadas?: boolean
  cuotas_6_habilitadas?: boolean
  promo_event_id?: string | null
  promo_original_precio?: number | null
  promo_original_precio_anterior?: number | null
  promo_original_descuento?: number | null
  promo_original_cuotas_2_habilitadas?: boolean | null
  promo_original_cuotas_3_habilitadas?: boolean | null
  promo_original_cuotas_6_habilitadas?: boolean | null
  stock?: number
  categoria_id?: number | null
  destacado?: boolean
  activo?: boolean
  imagen_principal?: string | null
  video_url?: string | null
  peso_empaquetado_kg?: number | null
  alto_paquete_cm?: number | null
  ancho_paquete_cm?: number | null
  largo_paquete_cm?: number | null
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
  peso_empaquetado_kg?: number | null
  alto_paquete_cm?: number | null
  ancho_paquete_cm?: number | null
  largo_paquete_cm?: number | null
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

const ADMIN_PRODUCTO_SELECT = `
  *,
  categorias(*),
  imagenes_producto(*),
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
  variantFilter?: "todas" | "sin_variantes"
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

export interface ProductVariantIssues {
  count: number
  hasIssues: boolean
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
      "id, product_id, variant_id, received_quantity, sellable_quantity, discounted_quantity, discount_percent, discount_reason, non_sellable_quantity, non_sellable_reason, conditioned_active, conditioned_name, conditioned_sku, conditioned_color_hex, conditioned_images, approved_at",
    )
    .in("product_id", productIds)
    .order("approved_at", { ascending: false })

  if (
    error &&
    /discount_reason|non_sellable_reason|conditioned_active|conditioned_name|conditioned_sku|conditioned_color_hex|conditioned_images|schema cache/i.test(
      error.message,
    )
  ) {
    const fallback = await supabase
      .from("inventory_return_movements")
      .select(
        "id, product_id, variant_id, received_quantity, sellable_quantity, discounted_quantity, discount_percent, non_sellable_quantity, approved_at",
      )
      .in("product_id", productIds)
      .order("approved_at", { ascending: false })

    data = fallback.data?.map((item) => ({
      ...item,
      discount_reason: null,
      non_sellable_reason: null,
      conditioned_active: false,
      conditioned_name: null,
      conditioned_sku: null,
      conditioned_color_hex: null,
      conditioned_images: [],
    })) ?? null
    error = fallback.error
  }

  if (error) throw error

  const availabilityById = new Map<
    string,
    {
      original: number
      sold: number
      available: number
    }
  >()
  const availability = await supabase
    .from("conditioned_inventory_offers")
    .select("id, product_id, original_quantity, sold_quantity, available_quantity")
    .in("product_id", productIds)

  if (!availability.error) {
    for (const item of availability.data ?? []) {
      availabilityById.set(String(item.id), {
        original: Math.max(Number(item.original_quantity) || 0, 0),
        sold: Math.max(Number(item.sold_quantity) || 0, 0),
        available: Math.max(Number(item.available_quantity) || 0, 0),
      })
    }
  } else if (
    !/conditioned_inventory_offers|schema cache|does not exist/i.test(
      availability.error.message,
    )
  ) {
    throw availability.error
  }

  const conditionedByProduct = new Map<number, SupabaseConditionedStock[]>()
  const returnSummaryByProduct = new Map<
    number,
    {
      discounted: number
      nonSellable: number
      pendingReview: number
    }
  >()
  for (const item of data ?? []) {
    const productId = Number(item.product_id)
    if (!productId) continue

    const returnStock = classifyReturnStock({
      received: item.received_quantity,
      sellable: item.sellable_quantity,
      discounted: item.discounted_quantity,
      nonSellable: item.non_sellable_quantity,
    })
    const currentSummary = returnSummaryByProduct.get(productId) ?? {
      discounted: 0,
      nonSellable: 0,
      pendingReview: 0,
    }
    const availabilitySummary = availabilityById.get(String(item.id))
    const availableDiscounted =
      availabilitySummary?.available ?? returnStock.discounted
    returnSummaryByProduct.set(productId, {
      discounted: currentSummary.discounted + availableDiscounted,
      nonSellable: currentSummary.nonSellable + returnStock.nonSellable,
      pendingReview: currentSummary.pendingReview + returnStock.pendingReview,
    })

    const originalQuantity = Number(item.discounted_quantity ?? 0)
    const discountPercent = Number(item.discount_percent ?? 0)
    if (originalQuantity <= 0 || discountPercent <= 0) continue
    const quantity = availabilitySummary?.available ?? originalQuantity

    const conditionedItem: SupabaseConditionedStock = {
      id: String(item.id),
      product_id: productId,
      variant_id:
        item.variant_id == null ? null : Number(item.variant_id),
      original_quantity: availabilitySummary?.original ?? originalQuantity,
      sold_quantity: availabilitySummary?.sold ?? 0,
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
      active: item.conditioned_active === true && quantity > 0,
      approved_at: String(item.approved_at),
      conditioned_name:
        typeof item.conditioned_name === "string"
          ? item.conditioned_name
          : null,
      conditioned_sku:
        typeof item.conditioned_sku === "string"
          ? item.conditioned_sku
          : null,
      conditioned_color_hex:
        typeof item.conditioned_color_hex === "string"
          ? item.conditioned_color_hex
          : null,
      conditioned_images: Array.isArray(item.conditioned_images)
        ? item.conditioned_images.filter(
            (image): image is string => typeof image === "string",
          )
        : [],
    }
    conditionedByProduct.set(productId, [
      ...(conditionedByProduct.get(productId) ?? []),
      conditionedItem,
    ])
  }

  return productos.map((producto) => {
    const returnSummary = returnSummaryByProduct.get(producto.id)
    const stock = calculateInventoryStock({
      normal: producto.stock,
      discounted: returnSummary?.discounted,
      nonSellable: returnSummary?.nonSellable,
      pendingReview: returnSummary?.pendingReview,
    })

    return {
      ...producto,
      conditioned_stock: conditionedByProduct.get(producto.id) ?? [],
      inventory_stock_summary: {
        normal: stock.normal,
        discounted: stock.discounted,
        non_sellable: stock.nonSellable,
        pending_review: stock.pendingReview,
        sellable: stock.sellable,
        quarantine: stock.quarantine,
        physical: stock.physical,
      },
    }
  })
}

// ─────────────────────────────────────────────────────────────
// Productos
// ─────────────────────────────────────────────────────────────

export async function getProductos() {
  const { data, error } = await supabase
    .from("productos")
    .select(ADMIN_PRODUCTO_SELECT)
    .order("id", {
      ascending: false,
    })

  if (error) {
    throw error
  }

  const productos =
    (data || []) as SupabaseProducto[]

  const variantes = await getAdminProductoVariantes({
    productIds: productos.map((producto) => producto.id),
  })

  const variantesByProducto =
    (
      variantes
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
  variantFilter = "todas",
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
    .select(ADMIN_PRODUCTO_SELECT, { count: "exact" })

  const normalizedSearch = search.trim().replace(/[%(),]/g, " ")
  if (normalizedSearch) {
    const matchingVariants = await getAdminProductoVariantes({
      skuSearch: normalizedSearch,
    })
    const variantProductIds = [
      ...new Set(matchingVariants.map((item) => item.producto_id)),
    ]
    const variantSearchClause = variantProductIds.length
      ? `,id.in.(${variantProductIds.join(",")})`
      : ""

    query = query.or(
      `nombre.ilike.%${normalizedSearch}%,sku.ilike.%${normalizedSearch}%,codigo_barra.ilike.%${normalizedSearch}%${variantSearchClause}`,
    )
  }
  const normalizedColor = colorSearch.trim().replace(/[%(),]/g, " ")
  if (normalizedColor) {
    const matchingVariants = await getAdminProductoVariantes({
      colorSearch: normalizedColor,
    })
    const productIds = [
      ...new Set(matchingVariants.map((item) => item.producto_id)),
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
  if (variantFilter === "sin_variantes") {
    const variants = await getAdminProductoVariantes()
    const productIdsWithVariants = [
      ...new Set(variants.map((item) => item.producto_id)),
    ]

    if (productIdsWithVariants.length) {
      query = query.not(
        "id",
        "in",
        `(${productIdsWithVariants.join(",")})`,
      )
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

  const rawProducts = (data ?? []) as SupabaseProducto[]
  const pageVariants = rawProducts.length
    ? await getAdminProductoVariantes({
        productIds: rawProducts.map((product) => product.id),
      })
    : []
  const variantsByProduct = new Map<number, SupabaseProductoVariante[]>()
  for (const variant of pageVariants) {
    variantsByProduct.set(variant.producto_id, [
      ...(variantsByProduct.get(variant.producto_id) ?? []),
      variant,
    ])
  }
  const lowerSearch = normalizedSearch.toLocaleLowerCase("es")
  const productos = await attachProductReviewSummaries(
    await attachConditionedStock(
      rawProducts.map((producto) => {
        const sortedVariants = [
          ...(variantsByProduct.get(producto.id) ?? []),
        ].sort((a, b) => a.orden - b.orden || a.id - b.id)

        // Si la búsqueda coincide con alguna variante puntual (SKU, código
        // de barra o nombre/color), mostrar solo esas y no el resto de
        // variantes hermanas que no tienen nada que ver con lo tipeado.
        const matchingVariants = lowerSearch
          ? sortedVariants.filter((variant) =>
              [variant.sku, variant.codigo_barra, variant.nombre].some(
                (value) => value?.toLocaleLowerCase("es").includes(lowerSearch),
              ),
            )
          : []

        return {
          ...producto,
          producto_variantes: matchingVariants.length
            ? matchingVariants
            : sortedVariants,
        }
      }),
    ),
  )

  return {
    productos,
    total: count ?? 0,
    page: safePage,
    pageSize: safePageSize,
  }
}

export async function getProductVariantIssues(): Promise<ProductVariantIssues> {
  const { data, error } = await supabase
    .from("productos")
    .select("id")

  if (error) throw error

  const variants = await getAdminProductoVariantes()
  const variantsByProduct = new Map<number, SupabaseProductoVariante[]>()
  for (const variant of variants) {
    variantsByProduct.set(variant.producto_id, [
      ...(variantsByProduct.get(variant.producto_id) ?? []),
      variant,
    ])
  }
  const count = (data ?? []).filter((product) => {
    const variants = variantsByProduct.get(Number(product.id)) ?? []
    return (
      variants.length === 0 ||
      variants.some((variant) => !variant.sku?.trim())
    )
  }).length

  return {
    count,
    hasIssues: count > 0,
  }
}

export async function getProductColorOptions(): Promise<ProductColorOption[]> {
  const data = await getAdminProductoVariantes()

  const colors = new Map<string, ProductColorOption>()

  for (const variant of data) {
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
    .select(ADMIN_PRODUCTO_SELECT)
    .eq("id", id)
    .single()

  if (error) {
    throw error
  }

  const variants = await getAdminProductoVariantes({
    productIds: [id],
  })
  const [product] = await attachProductReviewSummaries([
    {
      ...(data as SupabaseProducto),
      producto_variantes: variants,
    },
    {
      ...(data as SupabaseProducto),
      producto_variantes: variants,
    },
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
  const catalogVariants = variantes.map((variant) => {
    const catalogVariant = { ...variant }
    delete catalogVariant.stock
    return catalogVariant
  })
  const rpcPayload = {
    p_producto: catalogProduct,
    p_imagenes: imagenes,
    p_variantes: catalogVariants,
    p_especificaciones: especificaciones,
  }
  const result = await supabase.rpc(
    "create_producto_completo_v2",
    rpcPayload,
  )
  const { data, error } = result

  if (error) {
    if (/create_producto_completo_v2|schema cache|PGRST202/i.test(error.message)) {
      throw new Error(
        "Falta aplicar la migración 20260730170000_inventory_integrity_and_variant_sales.sql.",
      )
    }
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

export async function updateProductoCatalog(
  id: number,
  catalog: ProductoPayload,
  primarySku: string | null,
  variantStates: Record<number, boolean>,
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error(
      "La sesión administrativa venció. Volvé a iniciar sesión.",
    )
  }

  const requestedVariantStates = Object.entries(variantStates)
    .map(([variantId, active]) => ({
      id: Number(variantId),
      active,
    }))
    .sort((left, right) => left.id - right.id)

  const response = await fetch(`/api/admin/products/${id}/catalog`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      catalog,
      primarySku,
      variantStates: requestedVariantStates,
    }),
    cache: "no-store",
  })
  const result = (await response.json().catch(() => null)) as
    | { product?: SupabaseProducto; error?: string }
    | null

  if (!response.ok || !result?.product) {
    throw new Error(
      result?.error || "No se pudo actualizar el producto.",
    )
  }

  return result.product
}

export interface ProductVariantCostInfo {
  variantId: number | null
  variantName: string | null
  unitCost: number | null
}

export interface ProductPricingInfo {
  knownUnitCost: number | null
  variantCosts: ProductVariantCostInfo[]
  /** Variantes VENDIBLES sin costo cargado: bloquean el margen objetivo. */
  missingVariantCosts: ProductVariantCostInfo[]
  pricingMode: "manual" | "target_margin"
  targetMarginPercent: number | null
  /**
   * El precio guardado ya no coincide con el que hoy exige el margen objetivo
   * (cambiaron las tarifas de Mercado Pago o el costo). Se recalcula al leer,
   * así que nunca queda una marca vieja guardada en base.
   */
  requiresRecalculation: boolean
  recalculatedPrice: number | null
  /** Motivo por el que el recálculo no se puede hacer (ej. variante sin costo). */
  recalculationBlockedReason: string | null
}

export async function getProductPricing(id: number): Promise<ProductPricingInfo> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error(
      "La sesión administrativa venció. Volvé a iniciar sesión.",
    )
  }

  const response = await fetch(`/api/admin/products/${id}/pricing`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
    cache: "no-store",
  })
  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null

  if (!response.ok || !result) {
    const message = typeof result?.error === "string" ? result.error : null
    throw new Error(message || "No se pudo consultar la rentabilidad del producto.")
  }

  const parseVariantCosts = (value: unknown): ProductVariantCostInfo[] =>
    (Array.isArray(value) ? value : []).map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>
      return {
        variantId: typeof item.variantId === "number" ? item.variantId : null,
        variantName: typeof item.variantName === "string" ? item.variantName : null,
        unitCost: typeof item.unitCost === "number" ? item.unitCost : null,
      }
    })

  return {
    knownUnitCost: typeof result.knownUnitCost === "number" ? result.knownUnitCost : null,
    variantCosts: parseVariantCosts(result.variantCosts),
    missingVariantCosts: parseVariantCosts(result.missingVariantCosts),
    pricingMode: result.pricingMode === "target_margin" ? "target_margin" : "manual",
    targetMarginPercent:
      typeof result.targetMarginPercent === "number" ? result.targetMarginPercent : null,
    requiresRecalculation: result.requiresRecalculation === true,
    recalculatedPrice:
      typeof result.recalculatedPrice === "number" ? result.recalculatedPrice : null,
    recalculationBlockedReason:
      typeof result.recalculationBlockedReason === "string"
        ? result.recalculationBlockedReason
        : null,
  }
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
          original_quantity?: number
          sold_quantity?: number
          available_quantity?: number
          discount_percent: number
          discount_reason: string | null
          non_sellable_quantity: number
          non_sellable_reason: string | null
          conditioned_active: boolean
          conditioned_name: string | null
          conditioned_sku: string | null
          conditioned_color_hex: string | null
          conditioned_images: string[]
          approved_at: string
        }
        deleted?: boolean
        archived?: boolean
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
    sourceVariantId?: number | null
    conditionedName?: string
    conditionedSku?: string
    conditionedColor?: string
    conditionedImages?: string[]
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
    original_quantity: Number(
      response.item.original_quantity ?? response.item.discounted_quantity,
    ),
    sold_quantity: Number(response.item.sold_quantity ?? 0),
    quantity: Number(
      response.item.available_quantity ?? response.item.discounted_quantity,
    ),
    discount_percent: Number(response.item.discount_percent),
    reason: response.item.discount_reason,
    non_sellable_quantity: Number(response.item.non_sellable_quantity),
    non_sellable_reason: response.item.non_sellable_reason,
    active: response.item.conditioned_active === true,
    approved_at: response.item.approved_at,
    conditioned_name: response.item.conditioned_name,
    conditioned_sku: response.item.conditioned_sku,
    conditioned_color_hex: response.item.conditioned_color_hex,
    conditioned_images: Array.isArray(response.item.conditioned_images)
      ? response.item.conditioned_images
      : [],
  } satisfies SupabaseConditionedStock
}

export async function deleteConditionedStock(id: string) {
  return conditionedStockRequest(id, { method: "DELETE" })
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

export async function mergeProducto(
  keepProductId: number,
  absorbProductId: number,
) {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error(
      "La sesión administrativa venció. Volvé a iniciar sesión.",
    )
  }

  const response = await fetch(`/api/admin/products/${keepProductId}/merge`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ absorbProductId }),
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => null)) as
    | { product?: SupabaseProducto; error?: string }
    | null

  if (!response.ok || !payload?.product) {
    throw new Error(payload?.error || "No se pudieron fusionar los productos.")
  }

  return payload.product
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
