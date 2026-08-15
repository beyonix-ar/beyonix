import { MercadoPagoConfig, Preference } from "mercadopago"
import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"
import { CheckoutShippingQuoteError } from "@/lib/cart/checkout-shipping"
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
import {
  calculateStoreBenefitDiscount,
  findActiveStoreBenefit,
  markStoreBenefitAsUsed,
} from "@/lib/customer-store-benefits"
import { getSiteSettings } from "@/lib/site-settings"

type CheckoutPayload = CheckoutOrderRequestPayload

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN

const mercadoPagoClient = accessToken
  ? new MercadoPagoConfig({ accessToken })
  : null

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

    if (
      process.env.NODE_ENV === "production" &&
      !process.env.MERCADOPAGO_WEBHOOK_SECRET
    ) {
      return NextResponse.json(
        {
          error:
            "Los pagos por Mercado Pago están temporalmente deshabilitados hasta completar la configuración segura.",
        },
        { status: 503 },
      )
    }

    const payload = (await request.json()) as CheckoutPayload
    const items = normalizeCheckoutOrderItems(payload.items)
    const customer = normalizeCheckoutOrderCustomer(payload.customer)
    const customerError = getCheckoutOrderCustomerValidationError(customer)

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

    const catalog = await loadAndValidateCheckoutOrderCatalog(
      supabase,
      admin,
      items,
    )
    const baseTotals = calculateCartTotals(catalog.cartRows)
    const requestedCredit = normalizeMoney(payload.customerCreditAmount)
    const siteSettings = await getSiteSettings()
    const normalizedShipping = normalizeCheckoutOrderShipping({
      shipping: payload.shipping,
      customer: payload.customer,
      items,
      productsTotal: baseTotals.productsTotal,
      customerCreditApplied: requestedCredit > 0,
      settings: siteSettings.shipping,
    })
    const shipping = getCheckoutOrderShippingFields(normalizedShipping)
    const totals = calculateCartTotals(
      catalog.cartRows,
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
    const totalAfterStoreBenefit = roundMoney(
      Math.max(totals.productsTotal - storeBenefitDiscountAmount, 0) +
        totals.shipping,
    )
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
      ...buildCheckoutOrderBase({
        userId: user?.id ?? null,
        total: totalAfterStoreBenefit,
        externalAmountDue: customerCreditApplication.externalAmountDue,
        creditBalanceUsed: customerCreditApplication.appliedAmount,
        paymentMethodId: "mercadopago",
        reservationSessionId: payload.reservationSessionId,
        storeBenefit,
        storeBenefitDiscountAmount,
        customer,
      }),
      payment_method_id: "mercadopago",
      payment_status: "pending_checkout",
      envio_proveedor: shipping.shipping_provider,
      ...shipping,
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

      const legacyPayload = {
        usuario_id: user?.id ?? null,
        total: totalAfterStoreBenefit,
        estado: "pendiente",
        payment_method_id: "mercadopago",
        payment_status: "pending_checkout",
        checkout_idempotency_key: payload.reservationSessionId?.trim()
          ? `checkout:${payload.reservationSessionId.trim()}`
          : null,
        envio_proveedor: shipping.shipping_provider,
        andreani_costo: shipping.shipping_cost_charged,
        cliente_nombre: customer.cliente_nombre,
        cliente_email: customer.cliente_email,
        cliente_telefono: customer.cliente_telefono,
        cliente_direccion: customer.cliente_direccion,
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

    await insertCheckoutOrderItemsAndValidateInventory({
      orderClient,
      admin,
      orderId: order.id,
      items,
      products: catalog.products,
      conditionedRows: catalog.conditionedRows,
      reservationSessionId: payload.reservationSessionId,
    })

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
    const preferenceItems = [
      {
        id: `order-${order.id}`,
        title:
          customerCreditApplication.appliedAmount > 0
            ? "Diferencia a pagar BEYONIX"
            : `Pedido BEYONIX BX-${1000 + order.id}`,
        quantity: 1,
        unit_price: customerCreditApplication.externalAmountDue,
        currency_id: "ARS",
      },
    ]
    const result = await preference.create({
      body: {
        external_reference: String(order.id),
        items: preferenceItems,
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
        notification_url: `${siteUrl}/api/mercadopago/webhook?source_news=webhooks`,
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
    const quoteConflict = error instanceof CheckoutShippingQuoteError

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos iniciar el pago.",
      },
      { status: stockConflict || quoteConflict ? 409 : 500 },
    )
  }
}
