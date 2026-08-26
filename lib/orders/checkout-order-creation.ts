import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"
import type { StoreBenefitRow } from "../customer-store-benefits.ts"
import {
  getConditionedStockIdFromValue,
  getVariantIdFromValue,
} from "../products/product-variants.ts"
import {
  assertConditionedCheckoutStock,
  getCheckoutOrderItemUnitPrice,
  getConditionedOrderItemFields,
  getConditionedUnitPrice,
  loadConditionedCheckoutRows,
  normalizeConditionedStockId,
  type ConditionedCheckoutRow,
} from "./conditioned-checkout.ts"
import {
  normalizeCheckoutShipping,
  type NormalizedCheckoutShipping,
} from "../cart/checkout-shipping.ts"
import {
  resolveVerifiedAndreaniBranch,
  type VerifiedAndreaniBranch,
} from "../andreani/checkout-quote.ts"
import { AndreaniError } from "../andreani/client.ts"
import { assertCatalogStock, STOCK_CHANGED_MESSAGE } from "../cart/stock-status.ts"
import { getColorName } from "../products/variant-color.ts"
import { getPaymentComposition } from "../customer-credit.ts"
import type { ShippingBonusSettings } from "../store-config.ts"
import {
  deleteIncompleteCheckoutOrder,
  validateCheckoutInventory,
} from "./checkout-inventory.ts"

export interface InsufficientStockConflictItem {
  productId: number
  variantId: number | null
  conditionedStockId: string | null
  displayName: string
  variantName: string | null
}

/**
 * Se lanza cuando uno o más ítems del carrito piden más cantidad de la que
 * hay realmente disponible para vender. A propósito NO lleva el stock real
 * en ninguna parte (ni en el mensaje ni en `items`): el cliente nunca debe
 * poder inferir cuánto inventario queda a partir de un error de checkout.
 * Reúne TODOS los conflictos del carrito en una sola instancia para que el
 * cliente los vea de una vez, en lugar de ir descubriéndolos uno por uno en
 * sucesivos intentos de pago.
 */
export class InsufficientStockError extends Error {
  readonly items: InsufficientStockConflictItem[]

  constructor(items: InsufficientStockConflictItem[]) {
    super(STOCK_CHANGED_MESSAGE)
    this.name = "InsufficientStockError"
    this.items = items
  }
}

export interface CheckoutOrderItemInput {
  productId?: number
  quantity?: number
  variantId?: number | null
  conditionedStockId?: string | null
  color?: string | null
}

export interface CheckoutOrderCustomerInput {
  nombre?: string
  email?: string
  telefono?: string
  dni?: string
  direccion?: string
  cpDestino?: string
  localidad?: string
  provincia?: string
}

export interface CheckoutOrderShippingInput {
  provider?: string
  type?: "sucursal" | "domicilio"
  quoteToken?: string
  /** idgla de la sucursal Andreani elegida por el cliente. Sólo relevante cuando type === "sucursal"; se reverifica server-side, nunca se persiste tal cual. */
  sucursalId?: string | number
}

export interface CheckoutOrderRequestPayload {
  items?: CheckoutOrderItemInput[]
  reservationSessionId?: string | null
  storeBenefitId?: string | null
  customerCreditAmount?: number | string | null
  customer?: CheckoutOrderCustomerInput
  shipping?: CheckoutOrderShippingInput
}

export interface NormalizedCheckoutOrderItem {
  productId: number
  quantity: number
  variantId: number | null
  conditionedStockId: string | null
}

export interface NormalizedCheckoutOrderCustomer {
  cliente_nombre: string | null
  cliente_email: string | null
  cliente_telefono: string | null
  cliente_dni: string | null
  cliente_direccion: string | null
  cp_destino: string | null
  localidad: string | null
  provincia: string | null
}

export interface CheckoutOrderProductRow {
  id: number
  nombre: string
  precio: number
  stock: number
  activo: boolean
}

export interface CheckoutOrderVariantRow {
  id: number
  producto_id: number
  nombre: string
  color_hex: string | null
  stock: number | null
  activo: boolean
  orden: number | null
}

export interface CheckoutOrderCartRow {
  product: CheckoutOrderProductRow
  quantity: number
  unitPrice: number
}

export interface PreparedCheckoutOrderCatalog {
  products: CheckoutOrderProductRow[]
  conditionedRows: Map<string, ConditionedCheckoutRow>
  cartRows: CheckoutOrderCartRow[]
}

interface CheckoutCatalogValidationMessages {
  unavailableProducts?: string
  invalidVariant?: (productName: string) => string
}

interface CheckoutOrderShippingParams {
  shipping: CheckoutOrderShippingInput | null | undefined
  customer: CheckoutOrderCustomerInput | null | undefined
  items: NormalizedCheckoutOrderItem[]
  productsTotal: number
  customerCreditApplied?: boolean
  settings: ShippingBonusSettings
}

interface CheckoutOrderBaseParams {
  userId: string | null
  total: number
  externalAmountDue: number
  creditBalanceUsed: number
  paymentMethodId: string
  reservationSessionId?: string | null
  storeBenefit?: Pick<
    StoreBenefitRow,
    "id" | "code" | "benefit_type" | "percent"
  > | null
  storeBenefitDiscountAmount: number
  customer: NormalizedCheckoutOrderCustomer
}

interface PersistCheckoutOrderItemsParams {
  orderClient: CheckoutOrderDatabaseClient
  admin: CheckoutOrderDatabaseClient
  orderId: number
  items: NormalizedCheckoutOrderItem[]
  products: CheckoutOrderProductRow[]
  conditionedRows: Map<string, ConditionedCheckoutRow>
  reservationSessionId?: string | null
  insertErrorMessage?: string
}

type CheckoutOrderDatabaseClient = ReturnType<typeof createAdminClient>

const PRODUCT_SELECT = "id, nombre, precio, stock, activo"
const VARIANT_SELECT = "id, producto_id, nombre, color_hex, stock, activo, orden"

export function normalizeCheckoutOrderItems(
  items: CheckoutOrderItemInput[] | null | undefined,
) {
  if (!Array.isArray(items)) return []

  return items
    .map((item): NormalizedCheckoutOrderItem => {
      const conditionedStockId =
        normalizeConditionedStockId(item.conditionedStockId) ||
        getConditionedStockIdFromValue(item.color)

      return {
        productId: Number(item.productId),
        quantity: Math.trunc(Number(item.quantity)),
        variantId: conditionedStockId
          ? null
          : Number(item.variantId) ||
            getVariantIdFromValue(item.color) ||
            null,
        conditionedStockId,
      }
    })
    .filter(
      (item) =>
        Number.isFinite(item.productId) &&
        Number.isFinite(item.quantity) &&
        item.quantity > 0,
    )
}

export function normalizeCheckoutOrderCustomer(
  customer: CheckoutOrderCustomerInput | null | undefined,
): NormalizedCheckoutOrderCustomer {
  return {
    cliente_nombre: customer?.nombre?.trim() || null,
    cliente_email: customer?.email?.trim() || null,
    cliente_telefono: customer?.telefono?.trim() || null,
    cliente_dni: customer?.dni?.replace(/\D/g, "").trim() || null,
    cliente_direccion: customer?.direccion?.trim() || null,
    cp_destino: customer?.cpDestino?.trim() || null,
    localidad: customer?.localidad?.trim() || null,
    provincia: customer?.provincia?.trim() || null,
  }
}

export function getCheckoutOrderCustomerValidationError(
  customer: NormalizedCheckoutOrderCustomer,
) {
  if (!customer.cliente_nombre || customer.cliente_nombre.length < 3) {
    return "Ingresá el nombre de quien recibe."
  }

  if (
    !customer.cliente_email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.cliente_email)
  ) {
    return "Ingresá un email válido."
  }

  const phone = customer.cliente_telefono?.replace(/\D/g, "") ?? ""
  if (phone.length < 8 || phone.length > 15) {
    return "Ingresá un teléfono válido."
  }

  if (!/^\d{7,8}$/.test(customer.cliente_dni ?? "")) {
    return "Ingresá un DNI válido."
  }

  if (!customer.cliente_direccion || customer.cliente_direccion.length < 5) {
    return "Ingresá una dirección válida."
  }

  return ""
}

export async function loadAndValidateCheckoutOrderCatalog(
  catalogClient: CheckoutOrderDatabaseClient,
  admin: CheckoutOrderDatabaseClient,
  items: NormalizedCheckoutOrderItem[],
  messages: CheckoutCatalogValidationMessages = {},
): Promise<PreparedCheckoutOrderCatalog> {
  const productIds = [...new Set(items.map((item) => item.productId))]
  const { data: products, error: productsError } = await catalogClient
    .from("productos")
    .select(PRODUCT_SELECT)
    .in("id", productIds)

  if (productsError) {
    throw new Error("No se pudieron validar los productos.")
  }

  const productRows = (products ?? []) as CheckoutOrderProductRow[]
  if (productRows.length !== productIds.length) {
    throw new Error(
      messages.unavailableProducts ??
        "Hay productos que ya no están disponibles.",
    )
  }

  const { data: variants, error: variantsError } = await catalogClient
    .from("producto_variantes")
    .select(VARIANT_SELECT)
    .in("producto_id", productIds)

  if (variantsError) {
    throw new Error("No se pudieron validar las variantes.")
  }

  const variantRows = (variants ?? []) as CheckoutOrderVariantRow[]
  const conditionedRows = await loadConditionedCheckoutRows(admin, items)

  return prepareCheckoutOrderCatalogRows(
    items,
    productRows,
    variantRows,
    conditionedRows,
    messages,
  )
}

export function prepareCheckoutOrderCatalogRows(
  items: NormalizedCheckoutOrderItem[],
  productRows: CheckoutOrderProductRow[],
  variantRows: CheckoutOrderVariantRow[],
  conditionedRows: Map<string, ConditionedCheckoutRow>,
  messages: CheckoutCatalogValidationMessages = {},
): PreparedCheckoutOrderCatalog {
  const variantsById = new Map(
    variantRows.map((variant) => [variant.id, variant]),
  )
  const variantsByProductId = new Map<number, CheckoutOrderVariantRow[]>()

  for (const variant of variantRows) {
    const productVariants = variantsByProductId.get(variant.producto_id) ?? []
    productVariants.push(variant)
    productVariants.sort(
      (left, right) =>
        (left.orden ?? 0) - (right.orden ?? 0) || left.id - right.id,
    )
    variantsByProductId.set(variant.producto_id, productVariants)
  }

  // Se juntan TODOS los conflictos de stock del carrito antes de fallar, en
  // vez de cortar en el primer ítem: el cliente tiene que ver de una sola
  // vez todo lo que tiene que ajustar, no ir descubriéndolo pedido a pedido.
  const stockConflicts: InsufficientStockConflictItem[] = []

  for (const item of items) {
    if (!item.variantId && !item.conditionedStockId) {
      const activeVariants =
        variantsByProductId
          .get(item.productId)
          ?.filter((variant) => variant.activo) ?? []
      if (activeVariants.length === 1) {
        item.variantId = activeVariants[0].id
      } else if (activeVariants.length > 1) {
        throw new Error(
          "Elegí la variante exacta antes de confirmar la compra.",
        )
      }
    }

    const product = productRows.find((row) => row.id === item.productId)
    if (!product) throw new Error("Producto inexistente.")

    const variant = item.variantId
      ? variantsById.get(item.variantId)
      : undefined

    if (item.variantId && (!variant || variant.producto_id !== product.id)) {
      throw new Error(
        messages.invalidVariant?.(product.nombre) ??
          `Variante inválida para ${product.nombre}.`,
      )
    }

    // Un producto/variante desactivado no es un problema de "cantidad": ni
    // reduciéndola el cliente puede continuar. Se corta de inmediato con el
    // mensaje genérico de disponibilidad, en vez de sumarlo a la lista de
    // conflictos de stock insuficiente (que sí se resuelven bajando la
    // cantidad pedida).
    if (
      !item.conditionedStockId &&
      (product.activo === false ||
        (variant ? variant.activo === false : false))
    ) {
      throw new Error(STOCK_CHANGED_MESSAGE)
    }

    let hasStock = true
    let conditioned: ConditionedCheckoutRow | null = null

    try {
      conditioned = assertConditionedCheckoutStock(item, conditionedRows)
    } catch {
      hasStock = false
    }

    if (hasStock && !conditioned) {
      try {
        assertCatalogStock(item.quantity, product, variant)
      } catch {
        hasStock = false
      }
    }

    if (!hasStock) {
      stockConflicts.push({
        productId: item.productId,
        variantId: item.variantId,
        conditionedStockId: item.conditionedStockId,
        displayName: product.nombre,
        variantName: variant
          ? getColorName(variant.color_hex, variant.nombre)
          : null,
      })
    }
  }

  if (stockConflicts.length > 0) {
    throw new InsufficientStockError(stockConflicts)
  }

  const cartRows = items.map((item) => {
    const product = productRows.find((row) => row.id === item.productId)!

    return {
      product,
      quantity: item.quantity,
      unitPrice: getConditionedUnitPrice(
        product.precio,
        item.conditionedStockId
          ? conditionedRows.get(item.conditionedStockId)
          : null,
      ),
    }
  })

  return { products: productRows, conditionedRows, cartRows }
}

export function normalizeCheckoutOrderShipping({
  shipping,
  customer,
  items,
  productsTotal,
  customerCreditApplied = false,
  settings,
}: CheckoutOrderShippingParams) {
  return normalizeCheckoutShipping(
    shipping,
    {
      cpDestino: customer?.cpDestino,
      localidad: customer?.localidad,
      provincia: customer?.provincia,
      items,
    },
    productsTotal,
    { customerCreditApplied, settings },
  )
}

/**
 * Verificación server-side de la sucursal Andreani elegida por el cliente
 * (nunca se persiste lo que mandó el navegador tal cual). Domicilio no
 * requiere nada acá y devuelve null. Sucursal exige un id -- sin fallback
 * silencioso a domicilio ni destino inventado.
 */
export async function resolveCheckoutOrderShippingBranch(
  shipping: CheckoutOrderShippingInput | undefined,
  customer: CheckoutOrderCustomerInput | undefined,
  dependencies?: Parameters<typeof resolveVerifiedAndreaniBranch>[2],
): Promise<VerifiedAndreaniBranch | null> {
  if (shipping?.type !== "sucursal") return null

  const sucursalId = shipping.sucursalId
  if (
    sucursalId === undefined ||
    sucursalId === null ||
    String(sucursalId).trim() === ""
  ) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "Elegí una sucursal Andreani para continuar con el retiro en sucursal.",
    )
  }

  return resolveVerifiedAndreaniBranch(
    customer?.cpDestino ?? "",
    sucursalId,
    dependencies,
  )
}

export function getCheckoutOrderShippingFields(
  shipping: NormalizedCheckoutShipping,
  branch: VerifiedAndreaniBranch | null = null,
) {
  return {
    shipping_provider: shipping.provider,
    shipping_type: shipping.type,
    shipping_cost_real: shipping.costReal,
    shipping_cost_charged: shipping.costCharged,
    free_shipping_applied: shipping.freeShippingApplied,
    andreani_sucursal_id: branch?.id ?? null,
    andreani_sucursal_codigo: branch?.codigo ?? null,
    andreani_sucursal_nombre: branch?.nombre ?? null,
    andreani_sucursal_direccion: branch?.direccion ?? null,
    andreani_sucursal_localidad: branch?.localidad ?? null,
    andreani_sucursal_provincia: branch?.provincia ?? null,
    andreani_sucursal_cp: branch?.codigoPostal ?? null,
  }
}

export function buildCheckoutOrderBase({
  userId,
  total,
  externalAmountDue,
  creditBalanceUsed,
  paymentMethodId,
  reservationSessionId,
  storeBenefit,
  storeBenefitDiscountAmount,
  customer,
}: CheckoutOrderBaseParams) {
  return {
    usuario_id: userId,
    total,
    original_total: total,
    credit_balance_used: 0,
    external_amount_due: externalAmountDue,
    payment_composition: getPaymentComposition({
      paymentMethodId,
      creditBalanceUsed,
      externalAmountDue,
    }),
    estado: "pendiente",
    checkout_idempotency_key: reservationSessionId?.trim()
      ? `checkout:${reservationSessionId.trim()}`
      : null,
    store_benefit_id: storeBenefit?.id ?? null,
    store_benefit_code: storeBenefit?.code ?? null,
    store_benefit_type: storeBenefit?.benefit_type ?? null,
    store_benefit_percent: storeBenefit?.percent ?? null,
    store_benefit_discount_amount: storeBenefitDiscountAmount || null,
    ...customer,
  }
}

export function buildCheckoutOrderItemsPayload(
  orderId: number,
  items: NormalizedCheckoutOrderItem[],
  products: CheckoutOrderProductRow[],
  conditionedRows: Map<string, ConditionedCheckoutRow>,
) {
  return items.map((item) => {
    const product = products.find((row) => row.id === item.productId)
    const conditioned = item.conditionedStockId
      ? conditionedRows.get(item.conditionedStockId)
      : null

    return {
      orden_id: orderId,
      producto_id: item.productId,
      ...(!conditioned ? { variante_id: item.variantId } : {}),
      ...getConditionedOrderItemFields(conditioned),
      cantidad: item.quantity,
      precio: product
        ? getCheckoutOrderItemUnitPrice(product.id, product.precio, conditioned)
        : 0,
    }
  })
}

export async function insertCheckoutOrderItemsAndValidateInventory({
  orderClient,
  admin,
  orderId,
  items,
  products,
  conditionedRows,
  reservationSessionId,
  insertErrorMessage = "No se pudieron crear los ítems de la orden.",
}: PersistCheckoutOrderItemsParams) {
  const orderItemsPayload = buildCheckoutOrderItemsPayload(
    orderId,
    items,
    products,
    conditionedRows,
  )
  const { error } = await orderClient
    .from("orden_items")
    .insert(orderItemsPayload as never)

  if (error) {
    await deleteIncompleteCheckoutOrder(admin, orderId)
    throw new Error(error.message || insertErrorMessage)
  }

  try {
    await validateCheckoutInventory(
      admin,
      items,
      reservationSessionId,
      orderId,
    )
  } catch (inventoryError) {
    await deleteIncompleteCheckoutOrder(admin, orderId)
    throw inventoryError
  }
}
