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
} from "@/lib/customer-credit/server"
import {
  TRANSFER_ALIAS,
  TRANSFER_DISCOUNT_PERCENT,
  calculateTransferPaymentTotalAfterCustomerCredit,
} from "@/lib/payments/transfer"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { createGuestOrderAccessToken } from "@/lib/orders/guest-order-token"
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
import {
  calculateStoreBenefitDiscount,
  findActiveStoreBenefit,
  markStoreBenefitAsUsed,
} from "@/lib/customer-store-benefits"

type CheckoutPayload = CheckoutOrderRequestPayload

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as CheckoutPayload
    const items = normalizeCheckoutOrderItems(payload.items)
    const customer = normalizeCheckoutOrderCustomer(payload.customer)
    const customerError = getCheckoutOrderCustomerValidationError(customer)

    if (!items.length) {
      return NextResponse.json({ error: "El carrito esta vacio." }, { status: 400 })
    }

    if (customerError) {
      return NextResponse.json({ error: customerError }, { status: 400 })
    }

    const supabase = await createClient()
    const admin = createAdminClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const catalog = await loadAndValidateCheckoutOrderCatalog(
      supabase,
      admin,
      items,
      {
        unavailableProducts: "Hay productos que ya no estan disponibles.",
        invalidVariant: (productName) =>
          `Variante invalida para ${productName}.`,
      },
    )
    const baseTotals = calculateCartTotals(catalog.cartRows)
    const requestedCredit = normalizeMoney(payload.customerCreditAmount)
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
    const productsTotalAfterStoreBenefit = Math.max(
      totals.productsTotal - storeBenefitDiscountAmount,
      0,
    )
    const availableCredit = user
      ? await getCustomerCreditBalance(admin, user.id)
      : 0
    const creditBeforeTransferDiscount =
      requestedCredit > 0
        ? calculateCustomerCreditApplication({
            availableBalance: availableCredit,
            eligibleTotal: productsTotalAfterStoreBenefit + totals.shipping,
            requestedAmount: requestedCredit,
          })
        : {
            appliedAmount: 0,
          }
    const transferPaymentTotals = calculateTransferPaymentTotalAfterCustomerCredit({
      productsTotal: productsTotalAfterStoreBenefit,
      shipping: totals.shipping,
      customerCreditAmount: creditBeforeTransferDiscount.appliedAmount,
    })
    const transferDiscountAmount = transferPaymentTotals.discount
    const transferTotal = roundMoney(
      productsTotalAfterStoreBenefit + totals.shipping - transferDiscountAmount
    )
    const customerCreditApplication =
      requestedCredit > 0
        ? calculateCustomerCreditApplication({
            availableBalance: availableCredit,
            eligibleTotal: transferTotal,
            requestedAmount: requestedCredit,
          })
        : {
            appliedAmount: 0,
            externalAmountDue: transferTotal,
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
      ...buildCheckoutOrderBase({
        userId: user?.id ?? null,
        total: transferTotal,
        externalAmountDue: customerCreditApplication.externalAmountDue,
        creditBalanceUsed: customerCreditApplication.appliedAmount,
        paymentMethodId: "transferencia",
        reservationSessionId: payload.reservationSessionId,
        storeBenefit,
        storeBenefitDiscountAmount,
        customer,
      }),
      envio_proveedor: shipping.shipping_provider,
      andreani_costo: shipping.shipping_cost_charged,
      payment_method_id: "transferencia",
      payment_type_id: null,
      payment_status: "pendiente_comprobante",
      transfer_alias: TRANSFER_ALIAS,
      transfer_discount_percent: TRANSFER_DISCOUNT_PERCENT,
      transfer_discount_amount: transferDiscountAmount,
      ...shipping,
    }

    const orderClient = user ? supabase : admin

    const { data: order, error: orderError } = await orderClient
      .from("ordenes")
      .insert(orderPayload as never)
      .select()
      .single()

    if (orderError || !order) {
      console.error("TRANSFER_CREATE_ORDER_SUPABASE_ERROR", {
        message: orderError?.message,
        details: orderError?.details,
        hint: orderError?.hint,
        code: orderError?.code,
      })

      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    await insertCheckoutOrderItemsAndValidateInventory({
      orderClient,
      admin,
      orderId: order.id,
      items,
      products: catalog.products,
      conditionedRows: catalog.conditionedRows,
      reservationSessionId: payload.reservationSessionId,
      insertErrorMessage: "No se pudieron crear los items de la orden.",
    })

    if (user && customerCreditApplication.appliedAmount > 0) {
      await applyCustomerCreditToOrder(admin, {
        userId: user.id,
        orderId: order.id,
        amount: customerCreditApplication.appliedAmount,
        description: `Saldo a favor aplicado al pedido BX-${1000 + order.id}`,
        sourceKey: `order:${order.id}:customer-credit:debit`,
      })
    }

    if (storeBenefit) {
      await markStoreBenefitAsUsed(admin, {
        benefitId: storeBenefit.id,
        orderId: order.id,
      })
    }

    await sendOrderStatusEmail({
      to: order.cliente_email,
      subject: `Registramos tu pedido BX-${1000 + order.id}`,
      html: `
        <h1>Pedido registrado</h1>
        <p>Hola ${order.cliente_nombre ?? ""}, registramos tu pedido BX-${1000 + order.id}.</p>
        <p>Cuando subas el comprobante y validemos el pago, comenzaremos a prepararlo.</p>
      `,
    })

    return NextResponse.json({
      order_id: order.id,
      redirect_url: `/checkout/success?method=transferencia&order_id=${order.id}`,
      guest_token: order.usuario_id ? null : createGuestOrderAccessToken(order.id),
    })
  } catch (error) {
    console.error("Error creando orden por transferencia", error)
    const stockConflict =
      error instanceof Error && error.message === STOCK_CHANGED_MESSAGE
    const quoteConflict = error instanceof CheckoutShippingQuoteError

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos registrar el pedido por transferencia.",
      },
      { status: stockConflict || quoteConflict ? 409 : 500 },
    )
  }
}
