import { NextResponse } from "next/server"

import {
  CheckoutShippingQuoteError,
} from "@/lib/cart/checkout-shipping"
import { calculateCartTotals } from "@/lib/cart/cart-totals"
import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"
import {
  calculateCustomerCreditApplication,
  normalizeMoney,
  roundMoney,
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
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import {
  TRANSFER_ALIAS,
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferPaymentTotalAfterCustomerCredit,
} from "@/lib/payments/transfer"
import {
  buildCheckoutOrderBase,
  getCheckoutOrderCustomerValidationError,
  getCheckoutOrderShippingFields,
  insertCheckoutOrderItemsAndValidateInventory,
  loadAndValidateCheckoutOrderCatalog,
  normalizeCheckoutOrderCustomer,
  normalizeCheckoutOrderItems,
  normalizeCheckoutOrderShipping,
  type CheckoutOrderRequestPayload,
} from "@/lib/orders/checkout-order-creation"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { getSiteSettings } from "@/lib/site-settings"

interface CheckoutPayload extends CheckoutOrderRequestPayload {
  paymentMethodId?: string | null
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
    const items = normalizeCheckoutOrderItems(payload.items)
    const customer = normalizeCheckoutOrderCustomer(payload.customer)
    const customerError = getCheckoutOrderCustomerValidationError(customer)
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

    const catalog = await loadAndValidateCheckoutOrderCatalog(
      admin,
      admin,
      items,
    )
    const baseTotals = calculateCartTotals(catalog.cartRows)
    const siteSettings = await getSiteSettings({ fresh: true })
    const normalizedShipping = normalizeCheckoutOrderShipping({
      shipping: payload.shipping,
      customer: payload.customer,
      items,
      productsTotal: baseTotals.productsTotal,
      customerCreditApplied: requestedCredit > 0,
      settings: siteSettings.shipping,
    })
    const shipping = getCheckoutOrderShippingFields(normalizedShipping)
    const totals = calculateCartTotals(catalog.cartRows, {
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
    const orderTotal = roundMoney(
      pricingPaymentMethod === "transferencia"
        ? productsTotalAfterStoreBenefit +
          totals.shipping -
          transferPaymentTotals.discount
        : productsTotalAfterStoreBenefit + totals.shipping
    )
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
        ...buildCheckoutOrderBase({
          userId: user.id,
          total: orderTotal,
          externalAmountDue: 0,
          creditBalanceUsed: creditApplication.appliedAmount,
          paymentMethodId: "customer_credit",
          reservationSessionId: payload.reservationSessionId,
          storeBenefit,
          storeBenefitDiscountAmount,
          customer,
        }),
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
        ...shipping,
      } as never)
      .select()
      .single()

    if (orderError || !order) {
      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    orderId = order.id
    await insertCheckoutOrderItemsAndValidateInventory({
      orderClient: admin,
      admin,
      orderId: order.id,
      items,
      products: catalog.products,
      conditionedRows: catalog.conditionedRows,
      reservationSessionId: payload.reservationSessionId,
    })

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
    const quoteConflict = error instanceof CheckoutShippingQuoteError

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos registrar el pedido con saldo a favor.",
      },
      { status: stockConflict || quoteConflict ? 409 : 500 }
    )
  }
}
