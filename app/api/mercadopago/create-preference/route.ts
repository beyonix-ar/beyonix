import { MercadoPagoConfig, Preference } from "mercadopago"
import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"
import {
  getProductDiscount,
  type ShippingBonusSettings,
} from "@/lib/store-config"
import {
  normalizeCheckoutShipping,
} from "@/lib/cart/checkout-shipping"
import { calculateCartTotals } from "@/lib/cart/cart-totals"
import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"
import {
  calculateCustomerCreditApplication,
  getPaymentComposition,
  normalizeMoney,
} from "@/lib/customer-credit"
import {
  applyCustomerCreditToOrder,
  getCustomerCreditBalance,
  reverseCustomerCreditForOrder,
} from "@/lib/customer-credit/server"
import {
  decrementCheckoutInventory,
  deleteIncompleteCheckoutOrder,
} from "@/lib/orders/checkout-inventory"
import { getVariantIdFromValue } from "@/lib/products/product-variants"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  calculateStoreBenefitDiscount,
  findActiveStoreBenefit,
  markStoreBenefitAsUsed,
} from "@/lib/customer-store-benefits"
import { getSiteSettings } from "@/lib/site-settings"

interface CheckoutItemPayload {
  productId?: number
  quantity?: number
  variantId?: number | null
  color?: string | null
}

interface CheckoutPayload {
  items?: CheckoutItemPayload[]
  reservationSessionId?: string | null
  storeBenefitId?: string | null
  customerCreditAmount?: number | string | null
  customer?: {
    nombre?: string
    email?: string
    telefono?: string
    dni?: string
    direccion?: string
    cpDestino?: string
    localidad?: string
    provincia?: string
  }
  shipping?: {
    provider?: string
    type?: "sucursal" | "domicilio"
    costReal?: number
    costCharged?: number
  }
}

interface ProductRow {
  id: number
  nombre: string
  precio: number
  stock: number
  activo: boolean
}

interface VariantRow {
  id: number
  producto_id: number
  nombre: string
  stock: number | null
  activo: boolean
  orden: number | null
}

interface NormalizedItem {
  productId: number
  quantity: number
  variantId: number | null
}

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN

const mercadoPagoClient = accessToken
  ? new MercadoPagoConfig({ accessToken })
  : null

function normalizeItems(items: CheckoutPayload["items"]) {
  if (!Array.isArray(items)) return []

  return items
    .map((item) => ({
      productId: Number(item.productId),
      quantity: Math.trunc(Number(item.quantity)),
      variantId: Number(item.variantId) || getVariantIdFromValue(item.color) || null,
    }))
    .filter(
      (item) =>
        Number.isFinite(item.productId) &&
        Number.isFinite(item.quantity) &&
        item.quantity > 0,
    )
}

function normalizeCustomer(customer: CheckoutPayload["customer"]) {
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

function validateCustomer(customer: CheckoutPayload["customer"]) {
  const normalized = normalizeCustomer(customer)

  if (!normalized.cliente_nombre || normalized.cliente_nombre.length < 3) {
    return "Ingresá el nombre de quien recibe."
  }

  if (
    !normalized.cliente_email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.cliente_email)
  ) {
    return "Ingresá un email válido."
  }

  const phone = normalized.cliente_telefono?.replace(/\D/g, "") ?? ""
  if (phone.length < 8 || phone.length > 15) {
    return "Ingresá un teléfono válido."
  }

  if (!/^\d{7,8}$/.test(normalized.cliente_dni ?? "")) {
    return "Ingresá un DNI válido."
  }

  if (!normalized.cliente_direccion || normalized.cliente_direccion.length < 5) {
    return "Ingresá una dirección válida."
  }

  return ""
}

function normalizeShipping(
  shipping: CheckoutPayload["shipping"],
  productsTotal: number,
  customerCreditApplied = false,
  shippingSettings: ShippingBonusSettings,
) {
  const normalizedShipping = normalizeCheckoutShipping(
    shipping,
    productsTotal,
    { customerCreditApplied, settings: shippingSettings },
  )

  return {
    shipping_provider: normalizedShipping.provider,
    shipping_type: normalizedShipping.type,
    shipping_cost_real: normalizedShipping.costReal,
    shipping_cost_charged: normalizedShipping.costCharged,
    free_shipping_applied: normalizedShipping.freeShippingApplied,
  }
}

function getUnitPrice(product: ProductRow) {
  return Math.round(product.precio * (1 - getProductDiscount(product.id)))
}

function getUnitPriceWithStoreBenefit(product: ProductRow, percent?: number | null) {
  const unitPrice = getUnitPrice(product)
  if (!percent) return unitPrice

  return Math.max(Math.round(unitPrice * (1 - percent / 100)), 1)
}

function assertStock(item: NormalizedItem, product: ProductRow, variant?: VariantRow) {
  if (!product.activo) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }

  if (variant) {
    if (!variant.activo) {
      throw new Error(STOCK_CHANGED_MESSAGE)
    }

    if ((variant.stock ?? 0) < item.quantity) {
      throw new Error(STOCK_CHANGED_MESSAGE)
    }

    return
  }

  if (product.stock < item.quantity) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }
}

async function insertOrderItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orderId: number,
  items: NormalizedItem[],
  products: ProductRow[],
) {
  const payload = items.map((item) => {
    const product = products.find((row) => row.id === item.productId)

    return {
      orden_id: orderId,
      producto_id: item.productId,
      variante_id: item.variantId,
      cantidad: item.quantity,
      precio: product ? getUnitPrice(product) : 0,
    }
  })

  const { error } = await supabase.from("orden_items").insert(payload as never)

  if (error) {
    throw new Error(error.message || "No se pudieron crear los ítems de la orden.")
  }
}

function isSchemaCacheColumnError(error: { message?: string } | null) {
  return Boolean(
    error?.message?.includes("schema cache") ||
      error?.message?.includes("Could not find the") ||
      error?.message?.includes("column")
  )
}

export async function POST(request: Request) {
  let creditAppliedOrderId: number | null = null

  try {
    if (!mercadoPagoClient) {
      return NextResponse.json(
        { error: "Mercado Pago no está configurado." },
        { status: 500 },
      )
    }

    const payload = (await request.json()) as CheckoutPayload
    const items = normalizeItems(payload.items)
    const customerError = validateCustomer(payload.customer)

    if (!items.length) {
      return NextResponse.json({ error: "El carrito está vacío." }, { status: 400 })
    }

    if (customerError) {
      return NextResponse.json({ error: customerError }, { status: 400 })
    }

    const supabase = await createClient()
    const admin = createAdminClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const productIds = [...new Set(items.map((item) => item.productId))]

    const { data: products, error: productsError } = await supabase
      .from("productos")
      .select("id, nombre, precio, stock, activo")
      .in("id", productIds)

    if (productsError) {
      throw new Error("No se pudieron validar los productos.")
    }

    const productRows = (products ?? []) as ProductRow[]

    if (productRows.length !== productIds.length) {
      throw new Error("Hay productos que ya no están disponibles.")
    }

    const { data: variants, error: variantsError } = await supabase
      .from("producto_variantes")
      .select("id, producto_id, nombre, stock, activo, orden")
      .in("producto_id", productIds)

    if (variantsError) {
      throw new Error("No se pudieron validar las variantes.")
    }

    const variantRows = (variants ?? []) as VariantRow[]
    const variantsById = new Map(variantRows.map((variant) => [variant.id, variant]))
    const variantsByProductId = new Map<number, VariantRow[]>()

    for (const variant of variantRows) {
      const list = variantsByProductId.get(variant.producto_id) ?? []
      list.push(variant)
      list.sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.id - b.id)
      variantsByProductId.set(variant.producto_id, list)
    }

    for (const item of items) {
      if (!item.variantId) {
        item.variantId =
          variantsByProductId
            .get(item.productId)
            ?.find((variant) => variant.activo)?.id ?? null
      }

      const product = productRows.find((row) => row.id === item.productId)
      if (!product) throw new Error("Producto inexistente.")

      const variant = item.variantId ? variantsById.get(item.variantId) : undefined

      if (item.variantId && (!variant || variant.producto_id !== product.id)) {
        throw new Error(`Variante inválida para ${product.nombre}.`)
      }

      assertStock(item, product, variant)
    }

    const baseTotals = calculateCartTotals(
      items.map((item) => {
        const product = productRows.find((row) => row.id === item.productId)!

        return {
          product,
          quantity: item.quantity,
        }
      }),
    )
    const requestedCredit = normalizeMoney(payload.customerCreditAmount)
    const siteSettings = await getSiteSettings()
    const shipping = normalizeShipping(
      payload.shipping,
      baseTotals.productsTotal,
      requestedCredit > 0,
      siteSettings.shipping,
    )
    const totals = calculateCartTotals(
      items.map((item) => {
        const product = productRows.find((row) => row.id === item.productId)!

        return {
          product,
          quantity: item.quantity,
        }
      }),
      {
        shippingCost: shipping.shipping_cost_charged,
      },
    )
    const storeBenefit = user
      ? await findActiveStoreBenefit(
          admin,
          user.id,
          payload.storeBenefitId,
        )
      : null
    const storeBenefitDiscountAmount = calculateStoreBenefitDiscount(
      totals.productsTotal,
      storeBenefit?.percent,
    )
    const totalAfterStoreBenefit =
      Math.max(totals.productsTotal - storeBenefitDiscountAmount, 0) +
      totals.shipping
    const customerCreditApplication =
      requestedCredit > 0
        ? calculateCustomerCreditApplication({
            availableBalance: user
              ? await getCustomerCreditBalance(admin, user.id)
              : 0,
            eligibleTotal: totalAfterStoreBenefit,
            requestedAmount: requestedCredit,
          })
        : {
            appliedAmount: 0,
            externalAmountDue: totalAfterStoreBenefit,
          }

    if (requestedCredit > 0 && !user) {
      return NextResponse.json(
        { error: "Iniciá sesión para usar tu saldo a favor." },
        { status: 401 },
      )
    }

    if (
      requestedCredit > 0 &&
      Math.abs(customerCreditApplication.appliedAmount - requestedCredit) > 0.009
    ) {
      return NextResponse.json(
        { error: "El saldo a favor disponible cambió. Revisá el total antes de pagar." },
        { status: 409 },
      )
    }

    if (customerCreditApplication.externalAmountDue <= 0) {
      return NextResponse.json(
        { error: "El saldo cubre el total. Confirmá la compra con saldo a favor." },
        { status: 400 },
      )
    }

    const orderPayload = {
      usuario_id: user?.id ?? null,
      total: totalAfterStoreBenefit,
      original_total: totalAfterStoreBenefit,
      credit_balance_used: 0,
      external_amount_due: customerCreditApplication.externalAmountDue,
      payment_composition: getPaymentComposition({
        paymentMethodId: "mercadopago",
        creditBalanceUsed: customerCreditApplication.appliedAmount,
        externalAmountDue: customerCreditApplication.externalAmountDue,
      }),
      estado: "pendiente",
      payment_method_id: "mercadopago",
      payment_status: "pending_checkout",
      envio_proveedor: shipping.shipping_provider,
      store_benefit_id: storeBenefit?.id ?? null,
      store_benefit_code: storeBenefit?.code ?? null,
      store_benefit_type: storeBenefit?.benefit_type ?? null,
      store_benefit_percent: storeBenefit?.percent ?? null,
      store_benefit_discount_amount: storeBenefitDiscountAmount || null,
      ...shipping,
      ...normalizeCustomer(payload.customer),
    }

    const orderClient = user ? supabase : admin

    let { data: order, error: orderError } = await orderClient
      .from("ordenes")
      .insert(orderPayload as never)
      .select()
      .single()

    if (orderError && isSchemaCacheColumnError(orderError)) {
      if (customerCreditApplication.appliedAmount > 0) {
        throw new Error("La base de datos todavía no reconoce el saldo a favor. Reintentá en unos segundos.")
      }

      const legacyCustomer = normalizeCustomer(payload.customer)

      const legacyPayload = {
        usuario_id: user?.id ?? null,
        total: totalAfterStoreBenefit,
        estado: "pendiente",
        payment_method_id: "mercadopago",
        payment_status: "pending_checkout",
        envio_proveedor: shipping.shipping_provider,
        andreani_costo: shipping.shipping_cost_charged,
        cliente_nombre: legacyCustomer.cliente_nombre,
        cliente_email: legacyCustomer.cliente_email,
        cliente_telefono: legacyCustomer.cliente_telefono,
        cliente_direccion: legacyCustomer.cliente_direccion,
      }

      const fallbackOrder = await orderClient
        .from("ordenes")
        .insert(legacyPayload as never)
        .select()
        .single()

      order = fallbackOrder.data
      orderError = fallbackOrder.error
    }

    if (orderError || !order) {
      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    await insertOrderItems(orderClient as never, order.id, items, productRows)

    try {
      await decrementCheckoutInventory(admin, items)
    } catch (inventoryError) {
      await deleteIncompleteCheckoutOrder(admin, order.id)
      throw inventoryError
    }

    if (user && customerCreditApplication.appliedAmount > 0) {
      await applyCustomerCreditToOrder(admin, {
        userId: user.id,
        orderId: order.id,
        amount: customerCreditApplication.appliedAmount,
        description: `Saldo a favor aplicado al pedido BX-${1000 + order.id}`,
        sourceKey: `order:${order.id}:customer-credit:debit`,
      })
      creditAppliedOrderId = order.id
    }

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      request.headers.get("origin") ||
      "http://localhost:3000"

    const preference = new Preference(mercadoPagoClient)
    const creditPreferenceItems = [
      {
        id: `order-${order.id}-external-balance`,
        title: "Diferencia a pagar BEYONIX",
        quantity: 1,
        unit_price: customerCreditApplication.externalAmountDue,
        currency_id: "ARS",
      },
    ]
    const result = await preference.create({
      body: {
        external_reference: String(order.id),
        items: customerCreditApplication.appliedAmount > 0 ? creditPreferenceItems : [
          ...items.map((item) => {
            const product = productRows.find((row) => row.id === item.productId)!

            return {
              id: String(product.id),
              title: product.nombre,
              quantity: item.quantity,
              unit_price: getUnitPriceWithStoreBenefit(
                product,
                storeBenefit?.percent,
              ),
              currency_id: "ARS",
            }
          }),
          ...(totals.shipping > 0
            ? [
                {
                  id: "shipping",
                  title: "Envío",
                  quantity: 1,
                  unit_price: totals.shipping,
                  currency_id: "ARS",
                },
              ]
            : []),
        ],
        payer: {
          name: payload.customer?.nombre,
          email: payload.customer?.email,
          phone: {
            number: payload.customer?.telefono,
          },
        },
        back_urls: {
          success: `${siteUrl}/checkout/success`,
          failure: `${siteUrl}/checkout/failure`,
          pending: `${siteUrl}/checkout/pending`,
        },
        notification_url: `${siteUrl}/api/mercadopago/webhook`,
      },
    })

    if (!result.init_point) {
      throw new Error("Mercado Pago no devolvió init_point.")
    }

    if (storeBenefit) {
      await markStoreBenefitAsUsed(admin, {
        benefitId: storeBenefit.id,
        orderId: order.id,
      })
    }

    return NextResponse.json({
      init_point: result.init_point,
      order_id: order.id,
    })
  } catch (error) {
    if (creditAppliedOrderId) {
      try {
        await reverseCustomerCreditForOrder(createAdminClient(), {
          orderId: creditAppliedOrderId,
          description: "Reintegro automático por error al iniciar Mercado Pago",
        })
      } catch (reversalError) {
        console.error("MERCADOPAGO_CREDIT_REVERSAL_ERROR", reversalError)
      }
    }

    console.error("Error creando preferencia de Mercado Pago", error)
    const stockConflict =
      error instanceof Error && error.message === STOCK_CHANGED_MESSAGE

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos iniciar el pago.",
      },
      { status: stockConflict ? 409 : 500 },
    )
  }
}
