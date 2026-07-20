import { NextResponse } from "next/server"

import { normalizeCheckoutShipping } from "@/lib/cart/checkout-shipping"
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
  calculateStoreBenefitDiscount,
  findActiveStoreBenefit,
  markStoreBenefitAsUsed,
} from "@/lib/customer-store-benefits"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import {
  decrementCheckoutInventory,
  deleteIncompleteCheckoutOrder,
} from "@/lib/orders/checkout-inventory"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import {
  TRANSFER_ALIAS,
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferPaymentTotalAfterCustomerCredit,
} from "@/lib/payments/transfer"
import { getVariantIdFromValue } from "@/lib/products/product-variants"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import {
  getProductDiscount,
  type ShippingBonusSettings,
} from "@/lib/store-config"
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
  paymentMethodId?: string | null
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
    freeShippingApplied?: boolean
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

function normalizeItems(items: CheckoutPayload["items"]) {
  if (!Array.isArray(items)) return []

  return items
    .map((item) => ({
      productId: Number(item.productId),
      quantity: Math.trunc(Number(item.quantity)),
      variantId:
        Number(item.variantId) || getVariantIdFromValue(item.color) || null,
    }))
    .filter(
      (item) =>
        Number.isFinite(item.productId) &&
        Number.isFinite(item.quantity) &&
        item.quantity > 0
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
  const normalizedShipping = normalizeCheckoutShipping(shipping, productsTotal, {
    customerCreditApplied,
    settings: shippingSettings,
  })

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

function assertStock(
  item: NormalizedItem,
  product: ProductRow,
  variant?: VariantRow
) {
  if (!product.activo) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }

  if (variant) {
    if (!variant.activo || (variant.stock ?? 0) < item.quantity) {
      throw new Error(STOCK_CHANGED_MESSAGE)
    }

    return
  }

  if (product.stock < item.quantity) {
    throw new Error(STOCK_CHANGED_MESSAGE)
  }
}

async function insertOrderItems(
  admin: ReturnType<typeof createAdminClient>,
  orderId: number,
  items: NormalizedItem[],
  products: ProductRow[]
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

  const { error } = await admin.from("orden_items").insert(payload as never)

  if (error) {
    throw new Error(error.message || "No se pudieron crear los ítems de la orden.")
  }
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json(
      { error: "Iniciá sesión para usar tu saldo a favor." },
      { status: 401 }
    )
  }

  let orderId: number | null = null
  let creditApplied = false
  const admin = createAdminClient()

  try {
    const payload = (await request.json()) as CheckoutPayload
    const items = normalizeItems(payload.items)
    const customerError = validateCustomer(payload.customer)
    const requestedCredit = normalizeMoney(payload.customerCreditAmount)
    const pricingPaymentMethod =
      payload.paymentMethodId === "transferencia" ? "transferencia" : "customer_credit"

    if (!items.length) {
      return NextResponse.json(
        { error: "El carrito está vacío." },
        { status: 400 }
      )
    }

    if (customerError) {
      return NextResponse.json({ error: customerError }, { status: 400 })
    }

    if (requestedCredit <= 0) {
      return NextResponse.json(
        { error: "Indicá el saldo a favor a utilizar." },
        { status: 400 }
      )
    }

    const productIds = [...new Set(items.map((item) => item.productId))]
    const { data: products, error: productsError } = await admin
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

    const { data: variants, error: variantsError } = await admin
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

    const cartRows = items.map((item) => {
      const product = productRows.find((row) => row.id === item.productId)!

      return {
        product,
        quantity: item.quantity,
      }
    })
    const baseTotals = calculateCartTotals(cartRows)
    const siteSettings = await getSiteSettings()
    const shipping = normalizeShipping(
      payload.shipping,
      baseTotals.productsTotal,
      requestedCredit > 0,
      siteSettings.shipping,
    )
    const totals = calculateCartTotals(cartRows, {
      shippingCost: shipping.shipping_cost_charged,
    })
    const storeBenefit = await findActiveStoreBenefit(
      admin,
      user.id,
      payload.storeBenefitId
    )
    const storeBenefitDiscountAmount = calculateStoreBenefitDiscount(
      totals.productsTotal,
      storeBenefit?.percent
    )
    const productsTotalAfterStoreBenefit = Math.max(
      totals.productsTotal - storeBenefitDiscountAmount,
      0
    )
    const balance = await getCustomerCreditBalance(admin, user.id)
    const creditBeforeTransferDiscount = calculateCustomerCreditApplication({
      availableBalance: balance,
      eligibleTotal: productsTotalAfterStoreBenefit + totals.shipping,
      requestedAmount: requestedCredit,
    })
    const transferPaymentTotals = calculateTransferPaymentTotalAfterCustomerCredit({
      productsTotal: productsTotalAfterStoreBenefit,
      shipping: totals.shipping,
      customerCreditAmount: creditBeforeTransferDiscount.appliedAmount,
    })
    const orderTotal =
      pricingPaymentMethod === "transferencia"
        ? productsTotalAfterStoreBenefit +
          totals.shipping -
          transferPaymentTotals.discount
        : productsTotalAfterStoreBenefit + totals.shipping
    const creditApplication = calculateCustomerCreditApplication({
      availableBalance: balance,
      eligibleTotal: orderTotal,
      requestedAmount: requestedCredit,
    })

    if (
      creditApplication.appliedAmount <= 0 ||
      creditApplication.externalAmountDue > 0
    ) {
      return NextResponse.json(
        { error: "Tu saldo a favor no cubre el total de la compra." },
        { status: 400 }
      )
    }

    const now = new Date().toISOString()
    const { data: order, error: orderError } = await admin
      .from("ordenes")
      .insert({
        usuario_id: user.id,
        total: orderTotal,
        original_total: orderTotal,
        credit_balance_used: 0,
        external_amount_due: 0,
        payment_composition: getPaymentComposition({
          paymentMethodId: "customer_credit",
          creditBalanceUsed: creditApplication.appliedAmount,
          externalAmountDue: 0,
        }),
        estado: "pendiente",
        envio_proveedor: shipping.shipping_provider,
        andreani_costo: shipping.shipping_cost_charged,
        payment_method_id: "customer_credit",
        payment_type_id: null,
        payment_status: "pending_credit",
        financial_status: "pending_payment",
        transfer_alias:
          pricingPaymentMethod === "transferencia" ? TRANSFER_ALIAS : null,
        transfer_discount_percent:
          pricingPaymentMethod === "transferencia"
            ? TRANSFER_DISCOUNT_PERCENT
            : null,
        transfer_discount_amount:
          pricingPaymentMethod === "transferencia"
            ? transferPaymentTotals.discount
            : 0,
        store_benefit_id: storeBenefit?.id ?? null,
        store_benefit_code: storeBenefit?.code ?? null,
        store_benefit_type: storeBenefit?.benefit_type ?? null,
        store_benefit_percent: storeBenefit?.percent ?? null,
        store_benefit_discount_amount: storeBenefitDiscountAmount || null,
        ...shipping,
        ...normalizeCustomer(payload.customer),
      } as never)
      .select()
      .single()

    if (orderError || !order) {
      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    orderId = order.id
    await insertOrderItems(admin, order.id, items, productRows)

    try {
      await decrementCheckoutInventory(admin, items)
    } catch (inventoryError) {
      await deleteIncompleteCheckoutOrder(admin, order.id)
      orderId = null
      throw inventoryError
    }

    await applyCustomerCreditToOrder(admin, {
      userId: user.id,
      orderId: order.id,
      amount: creditApplication.appliedAmount,
      description: `Saldo a favor aplicado al pedido BX-${1000 + order.id}`,
      sourceKey: `order:${order.id}:customer-credit:debit`,
    })
    creditApplied = true

    const { error: updateError } = await admin
      .from("ordenes")
      .update({
        estado: "pagado",
        payment_status: "confirmado",
        financial_status: "payment_confirmed",
        paid_at: now,
        payment_confirmed_at: now,
        payment_confirmed_amount: orderTotal,
        external_amount_due: 0,
      } as never)
      .eq("id", order.id)

    if (updateError) {
      throw updateError
    }

    if (storeBenefit) {
      await markStoreBenefitAsUsed(admin, {
        benefitId: storeBenefit.id,
        orderId: order.id,
      })
    }

    await appendOrderAuditEvent(admin, {
      orderId: order.id,
      actorType: "customer",
      actorId: user.id,
      action: "payment_confirmed_with_customer_credit",
      previousStatus: "pending_payment",
      newStatus: "payment_confirmed",
      metadata: {
        creditBalanceUsed: creditApplication.appliedAmount,
        externalAmountDue: 0,
      },
    })

    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Recibimos tu pedido BX-${1000 + order.id}`,
      html: `
        <h1>Pedido recibido</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, tu pedido BX-${1000 + order.id} fue pagado con saldo a favor.</p>
        <p>Cuando sea despachado te vamos a enviar el número o link de seguimiento.</p>
      `,
    })

    return NextResponse.json({
      order_id: order.id,
      redirect_url: `/checkout/success?method=customer_credit&order_id=${order.id}`,
    })
  } catch (error) {
    if (orderId && creditApplied) {
      try {
        await reverseCustomerCreditForOrder(admin, {
          orderId,
          description: "Reintegro automático por error al confirmar la compra",
          createdBy: user.id,
        })
      } catch (reversalError) {
        console.error("CUSTOMER_CREDIT_AUTO_REVERSAL_ERROR", reversalError)
      }
    }

    console.error("Error creando orden con saldo a favor", error)
    const stockConflict =
      error instanceof Error && error.message === STOCK_CHANGED_MESSAGE

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos registrar el pedido con saldo a favor.",
      },
      { status: stockConflict ? 409 : 500 }
    )
  }
}
