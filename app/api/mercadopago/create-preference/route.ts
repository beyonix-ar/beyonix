import { randomUUID } from "node:crypto"

import { MercadoPagoConfig, Preference } from "mercadopago"
import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"
import { CheckoutShippingQuoteError } from "@/lib/cart/checkout-shipping"
import { AndreaniError } from "@/lib/andreani/client"
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
  computeCustomerCheckoutFingerprint,
  getCheckoutOrderCustomerValidationError,
  getCheckoutOrderShippingFields,
  insertCheckoutOrderItemsAndValidateInventory,
  isDuplicateCustomerCheckoutAttempt,
  loadAndValidateCheckoutOrderCatalog,
  normalizeCheckoutOrderCustomer,
  normalizeCheckoutOrderItems,
  normalizeCheckoutOrderShipping,
  normalizeRequestedInstallmentsModality,
  resolveCheckoutOrderShippingBranch,
  InsufficientStockError,
  InvalidCheckoutItemsError,
  type CheckoutOrderRequestPayload,
} from "@/lib/orders/checkout-order-creation"
import {
  deleteIncompleteCheckoutOrder,
  MissingReservationSessionError,
} from "@/lib/orders/checkout-inventory"
import { getCartInstallmentEligibility, getEffectiveInstallmentPercent } from "@/lib/products/installments"
import {
  calculateCftea,
  getCartFinancedTotal,
  getInstallmentAmount,
  getMaxEligibleInstallmentCount,
  getPriceWithoutNationalTaxes,
  getTransferPrice,
  roundUpCheckoutTotalForInstallments,
  type InstallmentCount,
} from "@/lib/pricing/financed-pricing"
import type { CheckoutOrderPricingSnapshot } from "@/lib/orders/checkout-order-creation"
import {
  MERCADOPAGO_MAX_ATTEMPTS_PER_DAY,
  MERCADOPAGO_MAX_ATTEMPTS_PER_HOUR,
  MERCADOPAGO_MAX_ATTEMPTS_PER_IP_PER_HOUR,
  MERCADOPAGO_MAX_GLOBAL_ATTEMPTS_PER_HOUR,
  createMercadoPagoCheckoutFingerprint,
  getMercadoPagoCheckoutAttemptDecision,
  getMercadoPagoCheckoutIdempotencyKey,
  getMercadoPagoPreferenceExpiration,
  getMercadoPagoRequestFingerprint,
  isPostgresUniqueViolation,
  normalizeMercadoPagoCheckoutSessionId,
  type MercadoPagoCheckoutAttemptRow,
} from "@/lib/mercadopago/checkout-attempt"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  calculateStoreBenefitDiscount,
  claimActiveStoreBenefit,
  linkStoreBenefitToOrder,
  releaseStoreBenefitClaim,
} from "@/lib/customer-store-benefits"
import { getSiteSettings } from "@/lib/site-settings"
import { resolveTrustedSiteUrl } from "@/lib/site-url"

type CheckoutPayload = CheckoutOrderRequestPayload

interface MercadoPagoCheckoutOrderRow
  extends MercadoPagoCheckoutAttemptRow {
  external_amount_due?: number | null
  credit_balance_used?: number | null
  cliente_email?: string | null
  cliente_nombre?: string | null
  mercadopago_preference_generation?: number | null
}

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN

const mercadoPagoClient = accessToken
  ? new MercadoPagoConfig({ accessToken })
  : null

export async function POST(request: Request) {
  let creditAppliedOrderId: number | null = null
  let createdOrderId: number | null = null
  let claimedBenefitId: string | null = null

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
    const checkoutSessionId = normalizeMercadoPagoCheckoutSessionId(
      payload.reservationSessionId,
    )
    const items = normalizeCheckoutOrderItems(payload.items)
    const customer = normalizeCheckoutOrderCustomer(payload.customer)
    const customerError = getCheckoutOrderCustomerValidationError(customer)

    if (!checkoutSessionId) {
      return NextResponse.json(
        { error: "La sesión del carrito venció. Actualizá la página." },
        { status: 400 },
      )
    }

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
    const siteSettings = await getSiteSettings({ fresh: true })
    const normalizedShipping = normalizeCheckoutOrderShipping({
      shipping: payload.shipping,
      customer: payload.customer,
      items,
      productsTotal: baseTotals.productsTotal,
      customerCreditApplied: requestedCredit > 0,
      settings: siteSettings.shipping,
    })
    const shippingBranch = await resolveCheckoutOrderShippingBranch(
      payload.shipping,
      payload.customer,
    )
    const shipping = getCheckoutOrderShippingFields(
      normalizedShipping,
      shippingBranch,
    )
    // Se valida acá (antes de calcular el fingerprint) para que la
    // modalidad forme parte de la identidad del intento de pago: si el
    // cliente cambia de "pago único" a "3 cuotas" para el mismo carrito, el
    // fingerprint tiene que cambiar y generar una orden nueva -- nunca
    // reusar/"reclamar" una orden vieja calculada con otra modalidad.
    const requestedInstallmentsModality = normalizeRequestedInstallmentsModality(
      payload.installmentsModality,
    )
    if (
      requestedInstallmentsModality &&
      !getCartInstallmentEligibility(catalog.products).includes(
        requestedInstallmentsModality,
      )
    ) {
      return NextResponse.json(
        {
          error:
            "Esa cantidad de cuotas no está disponible para los productos de tu carrito.",
        },
        { status: 400 },
      )
    }

    const checkoutFingerprint = createMercadoPagoCheckoutFingerprint({
      sessionId: checkoutSessionId,
      userId: user?.id ?? null,
      items,
      customer: { ...customer },
      productsTotal: baseTotals.productsTotal,
      shipping: {
        provider: normalizedShipping.provider,
        type: normalizedShipping.type,
        costReal: normalizedShipping.costReal,
        costCharged: normalizedShipping.costCharged,
        freeShippingApplied: normalizedShipping.freeShippingApplied,
        sucursalId: shippingBranch?.id ?? null,
      },
      storeBenefitId: payload.storeBenefitId?.trim() || null,
      requestedCredit,
      installmentsModality: requestedInstallmentsModality,
    })
    const existingAttempts = await loadMercadoPagoCheckoutAttempts(
      admin,
      checkoutFingerprint,
    )
    const paidAttempt = existingAttempts.find(
      (attempt) =>
        getMercadoPagoCheckoutAttemptDecision(attempt).kind ===
        "already_paid",
    )

    if (paidAttempt) {
      return NextResponse.json(
        { error: "Esta compra ya fue pagada y no puede iniciarse nuevamente." },
        { status: 409 },
      )
    }

    const activeAttempt = existingAttempts.find((attempt) => {
      const decision = getMercadoPagoCheckoutAttemptDecision(attempt)
      return ["reuse", "in_progress", "claim_preference"].includes(
        decision.kind,
      )
    })

    if (activeAttempt) {
      const decision = getMercadoPagoCheckoutAttemptDecision(activeAttempt)

      if (decision.kind === "reuse") {
        return NextResponse.json({
          init_point: decision.initPoint,
          order_id: activeAttempt.id,
          reused: true,
        })
      }

      if (decision.kind === "in_progress") {
        return checkoutAttemptInProgressResponse()
      }

      const claimToken = randomUUID()
      const { data: generation, error: claimError } = await admin.rpc(
        "claim_mercadopago_order_preference",
        {
          p_order_id: activeAttempt.id,
          p_checkout_fingerprint: checkoutFingerprint,
          p_claim_token: claimToken,
        },
      )

      if (claimError) {
        throw new Error(
          claimError.message || "No se pudo renovar el intento de pago.",
        )
      }

      const preferenceGeneration = Number(generation ?? 0)
      if (preferenceGeneration <= 0) {
        return checkoutAttemptInProgressResponse()
      }

      try {
        const result = await createAndPersistMercadoPagoPreference({
          client: mercadoPagoClient,
          admin,
          order: activeAttempt,
          payload,
          request,
          checkoutFingerprint,
          claimToken,
          preferenceGeneration,
        })

        return NextResponse.json({
          init_point: result.initPoint,
          order_id: activeAttempt.id,
          reused: true,
        })
      } catch (error) {
        await releaseMercadoPagoPreferenceClaim(
          admin,
          activeAttempt.id,
          claimToken,
        )
        throw error
      }
    }

    const rateLimitResponse = await enforceMercadoPagoCheckoutRateLimits({
      admin,
      userId: user?.id ?? null,
      requestFingerprint: getMercadoPagoRequestFingerprint(request),
    })
    if (rateLimitResponse) return rateLimitResponse

    const totals = calculateCartTotals(
      catalog.cartRows,
      {
        shippingCost: shipping.shipping_cost_charged,
      },
    )
    const storeBenefit = user
      ? await claimActiveStoreBenefit(
          admin,
          user.id,
          payload.storeBenefitId,
        )
      : null
    if (storeBenefit) claimedBenefitId = storeBenefit.id
    const storeBenefitDiscountAmount = calculateStoreBenefitDiscount(
      totals.productsTotal,
      storeBenefit?.percent,
    )
    // Contado: productos netos (después de descuentos/beneficio de tienda) +
    // envío EFECTIVAMENTE cobrado al cliente (ya bonificado/gratis si
    // corresponde -- shipping.shipping_cost_charged nunca es el costo bruto
    // de Andreani). El envío SIEMPRE se cobra a costo real, sin importar el
    // método de pago -- nunca lleva recargo por financiación.
    const productsNet = Math.max(
      totals.productsTotal - storeBenefitDiscountAmount,
      0,
    )
    const cashTotal = roundMoney(productsNet + totals.shipping)

    // Financiado: suma de los precios financiados INDIVIDUALES de cada línea
    // del carrito (cada uno calculado con SU propio máximo de cuotas), nunca
    // recalculado con la tasa del mínimo común del carrito (ver
    // getCartFinancedTotal). El beneficio de tienda es un % uniforme sobre
    // TODO el carrito: como el gross-up es lineal, aplicar ese mismo % sobre
    // el total financiado crudo equivale exactamente a aplicarlo línea por
    // línea antes de financiar (regla: nunca financiar sobre un precio "de
    // lista" cuando el efectivo está rebajado).
    const rawCartFinancedTotal = getCartFinancedTotal(
      catalog.cartRows.map((row) => ({
        cashPrice: row.unitPrice,
        maxEligibleCount: getMaxEligibleInstallmentCount(row.product),
        quantity: row.quantity,
      })),
      siteSettings.installmentsFinancing,
    )
    const financedStoreBenefitDiscount = calculateStoreBenefitDiscount(
      rawCartFinancedTotal,
      storeBenefit?.percent,
    )
    const financedProductsNet = Math.max(
      rawCartFinancedTotal - financedStoreBenefitDiscount,
      0,
    )
    const financedTotal =
      rawCartFinancedTotal > 0
        ? roundMoney(financedProductsNet + totals.shipping)
        : null

    // Cuota máxima ofrecida al carrito (mínimo común entre productos -- ver
    // getCartInstallmentEligibility más arriba, ya usada para validar
    // `requestedInstallmentsModality`).
    const cartInstallmentEligibility = getCartInstallmentEligibility(catalog.products)
    const cartMaxEligibleCount: InstallmentCount | null = cartInstallmentEligibility.length
      ? (Math.max(...cartInstallmentEligibility) as InstallmentCount)
      : null

    // El total que efectivamente se cobra: financiado si el cliente eligió
    // cuotas, contado en cualquier otro caso (débito/tarjeta 1 pago). Nunca
    // se le suma nada más en Mercado Pago (evita doble recargo) -- este
    // monto YA es el total final.
    const totalAfterStoreBenefit =
      requestedInstallmentsModality != null && financedTotal != null
        ? financedTotal
        : cashTotal

    const transferDiscountPercent = siteSettings.pricing.transferDiscountPercent
    const nationalTaxesIncidencePercent = siteSettings.pricing.nationalTaxesIncidencePercent
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

    // Ajuste de redondeo final de cuotas, una única vez y sobre el monto
    // final a cobrar (ver roundUpCheckoutTotalForInstallments): depende de
    // las cuotas OFRECIDAS al carrito, no de la elegida, así 2/3/6 cobran el
    // mismo total. Pago único/contado nunca se redondea.
    const checkoutTotals =
      requestedInstallmentsModality != null && financedTotal != null
        ? roundUpCheckoutTotalForInstallments({
            total: totalAfterStoreBenefit,
            customerCreditApplied: customerCreditApplication.appliedAmount,
            offeredCounts: cartInstallmentEligibility,
          })
        : {
            total: totalAfterStoreBenefit,
            externalAmountDue: customerCreditApplication.externalAmountDue,
            customerCreditApplied: customerCreditApplication.appliedAmount,
            roundingAdjustment: 0,
          }
    // CFTEA sobre el MISMO total financiado final que se muestra y se cobra
    // (ya con el ajuste de redondeo de cuotas), antes de saldo a favor.
    const cftea =
      requestedInstallmentsModality != null && financedTotal != null
        ? (() => {
            const installmentAmount = getInstallmentAmount(checkoutTotals.total, requestedInstallmentsModality)
            const annualPercent =
              installmentAmount != null
                ? calculateCftea(cashTotal, installmentAmount, requestedInstallmentsModality)
                : null
            return annualPercent != null
              ? { monthlyRate: Math.pow(1 + annualPercent / 100, 1 / 12) - 1, annualPercent }
              : null
          })()
        : null
    const pricingSnapshot: CheckoutOrderPricingSnapshot = {
      cashPriceTotal: cashTotal,
      transferPriceTotal: getTransferPrice(cashTotal, transferDiscountPercent),
      financedPriceTotal: financedTotal,
      maxInstallmentCount: cartMaxEligibleCount,
      transferDiscountPercent,
      nationalTaxesIncidencePercent,
      cftea,
      installmentsRoundingAdjustment: checkoutTotals.roundingAdjustment,
      priceWithoutNationalTaxes: {
        cash: getPriceWithoutNationalTaxes(cashTotal, nationalTaxesIncidencePercent),
        financed:
          financedTotal != null
            ? getPriceWithoutNationalTaxes(financedTotal, nationalTaxesIncidencePercent)
            : null,
      },
    }

    const newPreferenceClaimToken = randomUUID()
    const orderPayload = {
      ...buildCheckoutOrderBase({
        userId: user?.id ?? null,
        total: checkoutTotals.total,
        externalAmountDue: checkoutTotals.externalAmountDue,
        creditBalanceUsed: checkoutTotals.customerCreditApplied,
        paymentMethodId: "mercadopago",
        reservationSessionId: checkoutSessionId,
        storeBenefit,
        storeBenefitDiscountAmount,
        customer,
        // Snapshot histórico: `count` es la modalidad EFECTIVAMENTE elegida;
        // `percent` es el costo interno de MP para la cuota MÁXIMA habilitada
        // (la que determinó el gross-up, ver getEffectiveInstallmentPercent)
        // -- el fee REAL de la cuota elegida vive en
        // mercadopago_payment_snapshot (capturado por el webhook), nunca acá.
        // surchargeAmount = financedTotal - cashTotal, el recargo real
        // cobrado al cliente por financiar.
        installments:
          requestedInstallmentsModality != null && financedTotal != null && cartMaxEligibleCount != null
            ? {
                count: requestedInstallmentsModality,
                percent: getEffectiveInstallmentPercent(
                  cartMaxEligibleCount,
                  siteSettings.installmentsFinancing,
                ),
                productsBaseAmount: cashTotal,
                surchargeAmount: roundMoney(financedTotal - cashTotal),
                maxEligibleCount: cartMaxEligibleCount,
              }
            : null,
        pricingSnapshot,
      }),
      checkout_idempotency_key: getMercadoPagoCheckoutIdempotencyKey(
        checkoutFingerprint,
        existingAttempts[0]?.id ?? null,
      ),
      mercadopago_checkout_fingerprint: checkoutFingerprint,
      customer_checkout_fingerprint: computeCustomerCheckoutFingerprint({
        userId: user?.id ?? null,
        items,
        shipping: {
          provider: shipping.shipping_provider,
          type: shipping.shipping_type,
          sucursalId: shipping.andreani_sucursal_id,
        },
        storeBenefitId: storeBenefit?.id ?? null,
      }),
      mercadopago_request_fingerprint:
        getMercadoPagoRequestFingerprint(request),
      mercadopago_preference_claim_token: newPreferenceClaimToken,
      mercadopago_preference_claimed_at: new Date().toISOString(),
      mercadopago_preference_generation: 1,
      admin_visible_at: null,
      payment_method_id: "mercadopago",
      payment_status: "pending_checkout",
      envio_proveedor: shipping.shipping_provider,
      ...shipping,
    }

    // La escritura de `ordenes` es exclusiva de service_role (anon/authenticated
    // sólo conservan SELECT desde la migración que revocó INSERT/UPDATE/DELETE
    // directos -- ver 20260906120000_harden_andreani_commercial_and_order_writes.sql):
    // usar el cliente de sesión del usuario acá fallaría con permission denied.
    const orderClient = admin

    const { data: order, error: orderError } = await orderClient
      .from("ordenes")
      .insert(orderPayload as never)
      .select()
      .single()

    if (orderError || !order) {
      if (isDuplicateCustomerCheckoutAttempt(orderError)) {
        return NextResponse.json(
          {
            error:
              "Ya tenés otra compra en curso con estos mismos productos. Continuá con esa compra o cancelala antes de iniciar una nueva.",
          },
          { status: 409 },
        )
      }

      if (isPostgresUniqueViolation(orderError)) {
        return checkoutAttemptInProgressResponse()
      }

      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    createdOrderId = order.id

    await insertCheckoutOrderItemsAndValidateInventory({
      orderClient,
      admin,
      orderId: order.id,
      items,
      products: catalog.products,
      conditionedRows: catalog.conditionedRows,
      reservationSessionId: checkoutSessionId,
    })

    if (user && checkoutTotals.customerCreditApplied > 0) {
      await applyCustomerCreditToOrder(admin, {
        userId: user.id,
        orderId: order.id,
        amount: checkoutTotals.customerCreditApplied,
        description: `Saldo a favor aplicado al pedido BX-${1000 + order.id}`,
        sourceKey: `order:${order.id}:customer-credit:debit`,
      })
      creditAppliedOrderId = order.id
    }

    const preferenceResult = await createAndPersistMercadoPagoPreference({
      client: mercadoPagoClient,
      admin,
      order: {
        ...(order as MercadoPagoCheckoutOrderRow),
        external_amount_due: checkoutTotals.externalAmountDue,
        credit_balance_used: checkoutTotals.customerCreditApplied,
      },
      payload,
      request,
      checkoutFingerprint,
      claimToken: newPreferenceClaimToken,
      preferenceGeneration: 1,
    })
    createdOrderId = null

    if (storeBenefit) {
      await linkStoreBenefitToOrder(admin, {
        benefitId: storeBenefit.id,
        orderId: order.id,
      })
    }

    return NextResponse.json({
      init_point: preferenceResult.initPoint,
      order_id: order.id,
      reused: false,
    })
  } catch (error) {
    if (claimedBenefitId) {
      // Best-effort, mismo criterio que la reversión de saldo de abajo: si
      // ya se vinculó a una orden real, releaseStoreBenefitClaim es un
      // no-op por su propio guard.
      try {
        await releaseStoreBenefitClaim(createAdminClient(), claimedBenefitId)
      } catch (releaseError) {
        console.error("STORE_BENEFIT_RELEASE_FAILED", releaseError)
      }
    }

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

    if (createdOrderId) {
      await deleteIncompleteCheckoutOrder(createAdminClient(), createdOrderId)
    }

    console.error("Error creando preferencia de Mercado Pago", error)

    if (error instanceof InsufficientStockError) {
      return NextResponse.json(
        { code: "INSUFFICIENT_STOCK", items: error.items },
        { status: 409 },
      )
    }

    if (error instanceof MissingReservationSessionError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    if (error instanceof InvalidCheckoutItemsError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }

    const stockConflict =
      error instanceof Error && error.message === STOCK_CHANGED_MESSAGE
    const quoteConflict = error instanceof CheckoutShippingQuoteError
    const branchConflict =
      error instanceof AndreaniError && error.code === "VALIDATION_ERROR"

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos iniciar el pago.",
      },
      { status: stockConflict || quoteConflict || branchConflict ? 409 : 500 },
    )
  }
}

const MERCADOPAGO_ATTEMPT_SELECT =
  "id, estado, financial_status, payment_status, payment_method_id, external_amount_due, credit_balance_used, cliente_email, cliente_nombre, mercadopago_init_point, mercadopago_preference_expires_at, mercadopago_preference_claimed_at, mercadopago_preference_generation, installments_count" as const

async function loadMercadoPagoCheckoutAttempts(
  admin: ReturnType<typeof createAdminClient>,
  checkoutFingerprint: string,
) {
  const { data, error } = await admin
    .from("ordenes")
    .select(MERCADOPAGO_ATTEMPT_SELECT)
    .eq("mercadopago_checkout_fingerprint", checkoutFingerprint)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(
      error.message || "No se pudo verificar el intento de pago anterior.",
    )
  }

  return (data ?? []) as MercadoPagoCheckoutOrderRow[]
}

async function releaseMercadoPagoPreferenceClaim(
  admin: ReturnType<typeof createAdminClient>,
  orderId: number,
  claimToken: string,
) {
  await admin
    .from("ordenes")
    .update({
      payment_status: "preference_error",
      mercadopago_preference_claim_token: null,
      mercadopago_preference_claimed_at: null,
    } as never)
    .eq("id", orderId)
    .eq("mercadopago_preference_claim_token", claimToken)
}

async function createAndPersistMercadoPagoPreference({
  client,
  admin,
  order,
  payload,
  request,
  checkoutFingerprint,
  claimToken,
  preferenceGeneration,
}: {
  client: MercadoPagoConfig
  admin: ReturnType<typeof createAdminClient>
  order: MercadoPagoCheckoutOrderRow
  payload: CheckoutPayload
  request: Request
  checkoutFingerprint: string
  claimToken: string
  preferenceGeneration: number
}) {
  const externalAmountDue = Number(order.external_amount_due)
  if (!Number.isFinite(externalAmountDue) || externalAmountDue <= 0) {
    throw new Error("El monto pendiente de la orden no es válido.")
  }

  // back_urls y notification_url no pueden depender del header Origin: un
  // Origin manipulado desviaría el webhook de confirmación de pago.
  const siteUrl = resolveTrustedSiteUrl(request)
  if (!siteUrl) {
    throw new Error(
      "La URL pública del sitio no está configurada; no se puede iniciar el pago.",
    )
  }
  const createdAt = new Date()
  const expiresAt = getMercadoPagoPreferenceExpiration(createdAt)
  const preference = new Preference(client)
  // Forzamos siempre payment_methods.installments: sin esto, Checkout Pro
  // puede ofrecer sus propias cuotas (con o sin interés propio) fuera del
  // control de BEYONIX en CUALQUIER compra, incluso una que nunca eligió
  // financiación. "1" = pago único; "installments_count" = exactamente la
  // modalidad que ya quedó calculada y persistida en la orden. Son las
  // opciones oficiales de Checkout Pro (tope + preselección); no existe un
  // "mínimo forzado" en la API -- el cliente todavía podría bajar la
  // cantidad de cuotas en la página de Mercado Pago según el medio de pago.
  const requestedInstallments = order.installments_count
    ? Number(order.installments_count)
    : 1
  const result = await preference.create({
    body: {
      external_reference: String(order.id),
      items: [
        {
          id: `order-${order.id}`,
          title:
            Number(order.credit_balance_used ?? 0) > 0
              ? "Diferencia a pagar BEYONIX"
              : `Pedido BEYONIX BX-${1000 + order.id}`,
          quantity: 1,
          unit_price: externalAmountDue,
          currency_id: "ARS",
        },
      ],
      payer: {
        name: payload.customer?.nombre,
        email: payload.customer?.email,
        phone: {
          number: payload.customer?.telefono,
        },
      },
      payment_methods: {
        installments: requestedInstallments,
        default_installments: requestedInstallments,
      },
      back_urls: {
        success: `${siteUrl}/checkout/success`,
        failure: `${siteUrl}/checkout/failure`,
        pending: `${siteUrl}/checkout/pending`,
      },
      expires: true,
      expiration_date_from: createdAt.toISOString(),
      expiration_date_to: expiresAt.toISOString(),
      notification_url: `${siteUrl}/api/mercadopago/webhook?source_news=webhooks`,
      metadata: {
        flow: "checkout_order",
        order_id: order.id,
        checkout_fingerprint: checkoutFingerprint,
      },
    },
    requestOptions: {
      idempotencyKey: `beyonix-order-${order.id}-preference-${preferenceGeneration}`,
    },
  })

  if (!result.init_point || !result.id) {
    throw new Error("Mercado Pago no devolvió una preferencia válida.")
  }

  const { data: persistedPreference, error } = await admin
    .from("ordenes")
    .update({
      mercadopago_preference_id: result.id,
      mercadopago_init_point: result.init_point,
      mercadopago_preference_expires_at: expiresAt.toISOString(),
      mercadopago_preference_claim_token: null,
      mercadopago_preference_claimed_at: null,
      payment_status: "preference_created",
    } as never)
    .eq("id", order.id)
    .eq("mercadopago_preference_claim_token", claimToken)
    .select("id")
    .maybeSingle()

  if (error || !persistedPreference) {
    throw new Error(
      error?.message || "No se pudo guardar la preferencia de Mercado Pago.",
    )
  }

  return {
    initPoint: result.init_point,
    preferenceId: result.id,
    expiresAt: expiresAt.toISOString(),
  }
}

async function enforceMercadoPagoCheckoutRateLimits({
  admin,
  userId,
  requestFingerprint,
}: {
  admin: ReturnType<typeof createAdminClient>
  userId: string | null
  requestFingerprint: string | null
}) {
  const now = Date.now()
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  const userHourlyQuery = userId
    ? admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("payment_method_id", "mercadopago")
        .eq("usuario_id", userId)
        .gte("created_at", oneHourAgo)
    : Promise.resolve({ count: 0 })
  const userDailyQuery = userId
    ? admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("payment_method_id", "mercadopago")
        .eq("usuario_id", userId)
        .gte("created_at", oneDayAgo)
    : Promise.resolve({ count: 0 })
  const ipHourlyQuery = requestFingerprint
    ? admin
        .from("ordenes")
        .select("id", { count: "exact", head: true })
        .eq("payment_method_id", "mercadopago")
        .eq("mercadopago_request_fingerprint", requestFingerprint)
        .gte("created_at", oneHourAgo)
    : Promise.resolve({ count: 0 })

  const [
    { count: userHourlyAttempts },
    { count: userDailyAttempts },
    { count: ipHourlyAttempts },
    { count: globalHourlyAttempts },
  ] = await Promise.all([
    userHourlyQuery,
    userDailyQuery,
    ipHourlyQuery,
    admin
      .from("ordenes")
      .select("id", { count: "exact", head: true })
      .eq("payment_method_id", "mercadopago")
      .gte("created_at", oneHourAgo),
  ])

  if (
    Number(userHourlyAttempts ?? 0) >= MERCADOPAGO_MAX_ATTEMPTS_PER_HOUR ||
    Number(userDailyAttempts ?? 0) >= MERCADOPAGO_MAX_ATTEMPTS_PER_DAY ||
    Number(ipHourlyAttempts ?? 0) >=
      MERCADOPAGO_MAX_ATTEMPTS_PER_IP_PER_HOUR ||
    Number(globalHourlyAttempts ?? 0) >=
      MERCADOPAGO_MAX_GLOBAL_ATTEMPTS_PER_HOUR
  ) {
    return NextResponse.json(
      {
        error:
          "Alcanzaste temporalmente el límite de intentos de pago. Esperá antes de volver a intentarlo.",
      },
      {
        status: 429,
        headers: { "Retry-After": "3600" },
      },
    )
  }

  return null
}

function checkoutAttemptInProgressResponse() {
  return NextResponse.json(
    {
      error:
        "El pago ya se está iniciando. Esperá unos segundos y volvé a intentarlo.",
    },
    {
      status: 409,
      headers: { "Retry-After": "3" },
    },
  )
}
