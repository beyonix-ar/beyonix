import { randomUUID } from "node:crypto"

import { MercadoPagoConfig, Preference } from "mercadopago"
import { NextResponse } from "next/server"

import { createClient } from "@/lib/supabase/server"
import { CheckoutShippingQuoteError } from "@/lib/cart/checkout-shipping"
import { AndreaniError } from "@/lib/andreani/client"
import { calculateCartTotals } from "@/lib/cart/cart-totals"
import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"
import { normalizeMoney, roundMoney } from "@/lib/customer-credit"
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
  resolveCheckoutOrderShippingBranch,
  InsufficientStockError,
  InvalidCheckoutItemsError,
  type CheckoutOrderRequestPayload,
  type NormalizedCheckoutOrderItem,
  type PreparedCheckoutOrderCatalog,
  CHECKOUT_TERMS_NOT_ACCEPTED_MESSAGE,
  hasAcceptedCheckoutTerms,
} from "@/lib/orders/checkout-order-creation"
import {
  deleteIncompleteCheckoutOrder,
  CheckoutReservationExpiredError,
  MissingReservationSessionError,
} from "@/lib/orders/checkout-inventory"
import {
  buildCheckoutEconomicState,
  buildMercadoPagoPricingSnapshot,
  calculateMercadoPagoCheckoutPricing,
  getMercadoPagoModeQuote,
  getMercadoPagoOrderInstallmentsFields,
  getMercadoPagoPreferenceInstallments,
  normalizeMercadoPagoCheckoutMode,
  type CheckoutPricingLine,
  type CheckoutPricingSettings,
} from "@/lib/pricing/checkout-pricing"
import {
  MERCADOPAGO_MAX_ATTEMPTS_PER_DAY,
  MERCADOPAGO_MAX_ATTEMPTS_PER_HOUR,
  MERCADOPAGO_MAX_ATTEMPTS_PER_IP_PER_HOUR,
  MERCADOPAGO_MAX_GLOBAL_ATTEMPTS_PER_HOUR,
  createCheckoutEconomicFingerprint,
  createMercadoPagoCheckoutFingerprint,
  getMercadoPagoCheckoutAttemptDecision,
  getMercadoPagoCheckoutIdempotencyKey,
  getMercadoPagoReservationPreferenceExpiration,
  getMercadoPagoRequestFingerprint,
  getPendingCustomerCheckoutOrderAction,
  isEconomicallyEquivalentAttempt,
  isPostgresUniqueViolation,
  normalizeMercadoPagoCheckoutSessionId,
  type MercadoPagoCheckoutAttemptRow,
} from "@/lib/mercadopago/checkout-attempt"
import {
  createMercadoPagoSupersedeDependencies,
  expireMercadoPagoPreference,
  supersedeStaleMercadoPagoOrder,
  type SupersedableMercadoPagoOrder,
} from "@/lib/mercadopago/checkout-supersede"
import {
  ensureMercadoPagoOrderReference,
  getMercadoPagoOrderExternalReference,
} from "@/lib/mercadopago/order-reference"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  claimActiveStoreBenefit,
  findCheckoutStoreBenefit,
  linkStoreBenefitToOrder,
  releaseStoreBenefitClaim,
  type CheckoutStoreBenefitPreview,
} from "@/lib/customer-store-benefits"
import { getSiteSettings } from "@/lib/site-settings"
import { resolveTrustedSiteUrl } from "@/lib/site-url"

type CheckoutPayload = CheckoutOrderRequestPayload
type AdminClient = ReturnType<typeof createAdminClient>

interface MercadoPagoCheckoutOrderRow
  extends MercadoPagoCheckoutAttemptRow, SupersedableMercadoPagoOrder {
  external_amount_due?: number | null
  credit_balance_used?: number | null
  cliente_email?: string | null
  cliente_nombre?: string | null
  mercadopago_preference_generation?: number | null
  customer_checkout_fingerprint?: string | null
  pricing_snapshot?: {
    economicFingerprint?: string | null
    mercadoPagoModality?: string | null
    preferenceMaxInstallments?: number | null
  } | null
}

const ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE =
  "Ya tenés otra compra en curso con estos mismos productos. Continuá con esa compra o cancelala antes de iniciar una nueva."
const ALREADY_PAID_MESSAGE =
  "Esta compra ya fue pagada y no puede iniciarse nuevamente."
const PRICING_CHANGED_MESSAGE =
  "Los precios o condiciones de tu compra se actualizaron. Revisá el nuevo total antes de pagar."

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN

const mercadoPagoClient = accessToken
  ? new MercadoPagoConfig({ accessToken })
  : null

function normalizeExpectedTotal(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? roundMoney(parsed) : null
}

function buildCheckoutPricingLines(
  items: NormalizedCheckoutOrderItem[],
  catalog: PreparedCheckoutOrderCatalog,
): CheckoutPricingLine[] {
  // `cartRows` se arma con `items.map` (mismo orden, misma longitud).
  return catalog.cartRows.map((row, index) => ({
    productId: items[index].productId,
    variantId: items[index].variantId,
    conditionedStockId: items[index].conditionedStockId,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    installments: row.product,
  }))
}

/**
 * Crea (o retoma) el intento de pago de Mercado Pago. El servidor es la
 * ÚNICA fuente de verdad: en CADA click en "Pagar" se recalcula todo con
 * datos actuales de la base (catálogo, variantes, stock, envío, beneficio,
 * saldo, configuración de cuotas/fees/transferencia) y se arma una huella
 * económica determinística. Una orden pendiente previa se reutiliza SÓLO si
 * su huella económica coincide exactamente; si no, se da de baja de forma
 * segura (`supersedeStaleMercadoPagoOrder`) y se crea una nueva con los
 * valores actuales. Nunca se confía en montos enviados por el navegador.
 */
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
    if (!hasAcceptedCheckoutTerms(payload)) {
      return NextResponse.json(
        { code: "TERMS_NOT_ACCEPTED", error: CHECKOUT_TERMS_NOT_ACCEPTED_MESSAGE },
        { status: 400 },
      )
    }
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

    const requestedCredit = normalizeMoney(payload.customerCreditAmount)
    if (requestedCredit > 0 && !user) {
      return NextResponse.json(
        { error: "Iniciá sesión para usar tu saldo a favor." },
        { status: 401 },
      )
    }

    // ── 1. Estado comercial ACTUAL (nunca lo que mandó el navegador) ──
    const catalog = await loadAndValidateCheckoutOrderCatalog(
      supabase,
      admin,
      items,
    )
    const pricingLines = buildCheckoutPricingLines(items, catalog)
    const siteSettings = await getSiteSettings({ fresh: true })
    const pricingSettings: CheckoutPricingSettings = {
      installmentsFinancing: siteSettings.installmentsFinancing,
      transferDiscountPercent: siteSettings.pricing.transferDiscountPercent,
      nationalTaxesIncidencePercent:
        siteSettings.pricing.nationalTaxesIncidencePercent,
    }
    const normalizedShipping = normalizeCheckoutOrderShipping({
      shipping: payload.shipping,
      customer: payload.customer,
      items,
      productsTotal: calculateCartTotals(catalog.cartRows).productsTotal,
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
    const mode = normalizeMercadoPagoCheckoutMode(
      payload.mercadoPagoMode,
      payload.installmentsModality,
    )

    // ── 2. Beneficio de tienda y orden pendiente de esta misma compra ──
    // El cupón se LEE sin reclamarlo: si está vinculado a la orden pendiente
    // de esta misma compra, sigue aplicando (se reutiliza esa orden o se
    // libera al darla de baja).
    const benefitPreview = user
      ? await findCheckoutStoreBenefit(admin, user.id, payload.storeBenefitId)
      : null
    const customerFingerprintFor = (benefitId: string | null) =>
      computeCustomerCheckoutFingerprint({
        userId: user?.id ?? null,
        items,
        shipping: {
          provider: shipping.shipping_provider,
          type: shipping.shipping_type,
          sucursalId: shipping.andreani_sucursal_id,
        },
        storeBenefitId: benefitId,
      })

    let customerCheckoutFingerprint = customerFingerprintFor(
      benefitPreview?.id ?? null,
    )
    let pendingOrder = customerCheckoutFingerprint
      ? await findPendingCustomerCheckoutOrder(admin, customerCheckoutFingerprint)
      : null
    let storeBenefit: CheckoutStoreBenefitPreview | null = null

    if (benefitPreview?.status === "active") {
      storeBenefit = benefitPreview
    } else if (benefitPreview?.status === "used") {
      if (pendingOrder && benefitPreview.used_order_id === pendingOrder.id) {
        storeBenefit = benefitPreview
      } else {
        // Cupón usado por otra compra: no aplica (mismo criterio que un
        // claim fallido) y la identidad de la compra va sin cupón.
        customerCheckoutFingerprint = customerFingerprintFor(null)
        pendingOrder = customerCheckoutFingerprint
          ? await findPendingCustomerCheckoutOrder(admin, customerCheckoutFingerprint)
          : null
      }
    }

    // ── 3. Precio canónico y huella económica ──
    const pricing = calculateMercadoPagoCheckoutPricing({
      lines: pricingLines,
      shippingCharged: shipping.shipping_cost_charged,
      storeBenefitPercent: storeBenefit?.percent ?? null,
      requestedCustomerCredit: requestedCredit,
      settings: pricingSettings,
    })
    const quote = getMercadoPagoModeQuote(pricing, mode)

    if (!quote) {
      return NextResponse.json(
        {
          error:
            "La financiación en cuotas no está disponible para los productos de tu carrito.",
        },
        { status: 400 },
      )
    }

    if (quote.requestedCreditExceedsTotal) {
      return NextResponse.json(
        { error: "El saldo a favor disponible cambió. Revisá el total antes de pagar." },
        { status: 409 },
      )
    }

    if (quote.externalAmountDue <= 0) {
      return NextResponse.json(
        { error: "El saldo cubre el total. Confirmá la compra con saldo a favor." },
        { status: 400 },
      )
    }

    // El total que vio el cliente sólo sirve para NO cobrar algo distinto
    // de lo que tenía en pantalla (admin cambió algo mientras tanto). Se
    // corta antes de cualquier efecto (reuso, baja, claims, órdenes).
    const expectedTotal = normalizeExpectedTotal(payload.expectedTotal)
    if (
      expectedTotal != null &&
      Math.abs(expectedTotal - quote.externalAmountDue) > 0.009
    ) {
      return NextResponse.json(
        {
          code: "PRICING_CHANGED",
          error: PRICING_CHANGED_MESSAGE,
          total: quote.externalAmountDue,
          mode,
        },
        { status: 409 },
      )
    }

    const economicFingerprint = createCheckoutEconomicFingerprint(
      buildCheckoutEconomicState({
        lines: pricingLines,
        shipping: {
          provider: normalizedShipping.provider,
          type: normalizedShipping.type,
          sucursalId: shippingBranch?.id ?? null,
          costReal: normalizedShipping.costReal,
          costCharged: normalizedShipping.costCharged,
          freeShippingApplied: normalizedShipping.freeShippingApplied,
        },
        storeBenefit: storeBenefit
          ? { id: storeBenefit.id, percent: storeBenefit.percent }
          : null,
        requestedCustomerCredit: requestedCredit,
        mode,
        pricing,
        settings: pricingSettings,
      }),
    )
    const checkoutFingerprint = createMercadoPagoCheckoutFingerprint({
      sessionId: checkoutSessionId,
      userId: user?.id ?? null,
      customer: { ...customer },
      economicFingerprint,
    })

    // ── 4. Reintento idéntico (misma pestaña, mismas condiciones) ──
    const existingAttempts = await loadMercadoPagoCheckoutAttempts(
      admin,
      checkoutFingerprint,
    )
    if (
      existingAttempts.some(
        (attempt) =>
          getMercadoPagoCheckoutAttemptDecision(attempt).kind === "already_paid",
      )
    ) {
      return NextResponse.json({ error: ALREADY_PAID_MESSAGE }, { status: 409 })
    }

    const activeAttempt = existingAttempts.find((attempt) =>
      ["reuse", "in_progress", "claim_preference"].includes(
        getMercadoPagoCheckoutAttemptDecision(attempt).kind,
      ),
    )
    if (activeAttempt) {
      const response = await resolveMercadoPagoOrderAttempt({
        client: mercadoPagoClient,
        admin,
        order: activeAttempt,
        payload,
        request,
        economicFingerprint,
      })
      if (response) return response
    }

    // ── 5. Orden pendiente de esta misma compra (otra pestaña o intento viejo) ──
    if (pendingOrder && pendingOrder.id !== activeAttempt?.id) {
      const response = await resolvePendingCustomerCheckoutOrder({
        client: mercadoPagoClient,
        admin,
        order: pendingOrder,
        payload,
        request,
        economicFingerprint,
      })
      if (response) return response
    }

    const rateLimitResponse = await enforceMercadoPagoCheckoutRateLimits({
      admin,
      userId: user?.id ?? null,
      requestFingerprint: getMercadoPagoRequestFingerprint(request),
    })
    if (rateLimitResponse) return rateLimitResponse

    // ── 6. Reclamos atómicos: el estado real tiene que seguir siendo el calculado ──
    const claimedBenefit =
      user && storeBenefit
        ? await claimActiveStoreBenefit(admin, user.id, storeBenefit.id)
        : null
    if (claimedBenefit) claimedBenefitId = claimedBenefit.id

    if (storeBenefit && claimedBenefit?.percent !== storeBenefit.percent) {
      if (claimedBenefitId) {
        await releaseStoreBenefitClaimSafely(admin, claimedBenefitId)
        claimedBenefitId = null
      }
      return NextResponse.json(
        {
          code: "PRICING_CHANGED",
          error: "Tu beneficio ya no está disponible. Revisá el total antes de pagar.",
        },
        { status: 409 },
      )
    }

    if (user && requestedCredit > 0) {
      const balance = await getCustomerCreditBalance(admin, user.id)
      if (balance + 0.009 < requestedCredit) {
        if (claimedBenefitId) {
          await releaseStoreBenefitClaimSafely(admin, claimedBenefitId)
          claimedBenefitId = null
        }
        return NextResponse.json(
          { error: "El saldo a favor disponible cambió. Revisá el total antes de pagar." },
          { status: 409 },
        )
      }
    }

    // ── 7. Orden nueva con los valores actuales ──
    const pricingSnapshot = buildMercadoPagoPricingSnapshot({
      pricing,
      mode,
      settings: pricingSettings,
      economicFingerprint,
    })
    const newPreferenceClaimToken = randomUUID()
    const orderPayload = {
      ...buildCheckoutOrderBase({
        userId: user?.id ?? null,
        total: quote.total,
        externalAmountDue: quote.externalAmountDue,
        creditBalanceUsed: quote.customerCreditApplied,
        paymentMethodId: "mercadopago",
        reservationSessionId: checkoutSessionId,
        storeBenefit: claimedBenefit,
        storeBenefitDiscountAmount: pricing.storeBenefitDiscountAmount,
        customer,
        installments: getMercadoPagoOrderInstallmentsFields(
          pricing,
          mode,
          siteSettings.installmentsFinancing,
        ),
        pricingSnapshot,
      }),
      checkout_idempotency_key: getMercadoPagoCheckoutIdempotencyKey(
        checkoutFingerprint,
        existingAttempts[0]?.id ?? null,
      ),
      mercadopago_checkout_fingerprint: checkoutFingerprint,
      mercadopago_reservation_session_id: checkoutSessionId,
      customer_checkout_fingerprint: customerCheckoutFingerprint,
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
      if (claimedBenefitId) {
        await releaseStoreBenefitClaimSafely(admin, claimedBenefitId)
        claimedBenefitId = null
      }

      if (isDuplicateCustomerCheckoutAttempt(orderError)) {
        // Carrera: otra pestaña/request creó la orden pendiente de esta
        // misma compra entre la búsqueda (paso 5) y este INSERT. Sólo se
        // retoma si es económicamente idéntica; si no, nunca se reutiliza
        // (ni se da de baja acá: la acaban de crear) -- el cliente reintenta.
        const conflictOrder = customerCheckoutFingerprint
          ? await findPendingCustomerCheckoutOrder(admin, customerCheckoutFingerprint)
          : null

        if (
          conflictOrder?.payment_method_id === "mercadopago" &&
          isEconomicallyEquivalentAttempt(conflictOrder, economicFingerprint)
        ) {
          const response = await resolveMercadoPagoOrderAttempt({
            client: mercadoPagoClient,
            admin,
            order: conflictOrder,
            payload,
            request,
            economicFingerprint,
          })
          if (response) return response
        }

        return conflictOrder?.payment_method_id === "mercadopago"
          ? checkoutAttemptInProgressResponse()
          : NextResponse.json(
              { error: ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE },
              { status: 409 },
            )
      }

      if (isPostgresUniqueViolation(orderError)) {
        return checkoutAttemptInProgressResponse()
      }

      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    createdOrderId = order.id

    const reservationExpiresAt = await insertCheckoutOrderItemsAndValidateInventory({
      orderClient,
      admin,
      orderId: order.id,
      items,
      products: catalog.products,
      conditionedRows: catalog.conditionedRows,
      reservationSessionId: checkoutSessionId,
      reservationCommitment: "mercadopago",
    })
    if (!reservationExpiresAt) throw new CheckoutReservationExpiredError()

    if (user && quote.customerCreditApplied > 0) {
      await applyCustomerCreditToOrder(admin, {
        userId: user.id,
        orderId: order.id,
        amount: quote.customerCreditApplied,
        description: `Saldo a favor aplicado al pedido BX-${1000 + order.id}`,
        sourceKey: `order:${order.id}:customer-credit:debit`,
      })
      creditAppliedOrderId = order.id
    }

    if (claimedBenefit) {
      await linkStoreBenefitToOrder(admin, {
        benefitId: claimedBenefit.id,
        orderId: order.id,
      })
    }

    // From here the order owns the Step 3 reservation. Keep it on a provider
    // error so a retry can claim a preference for this same order and deadline.
    createdOrderId = null
    creditAppliedOrderId = null

    let preferenceResult
    try {
      preferenceResult = await createAndPersistMercadoPagoPreference({
        client: mercadoPagoClient,
        admin,
        order: {
          ...(order as MercadoPagoCheckoutOrderRow),
          external_amount_due: quote.externalAmountDue,
          credit_balance_used: quote.customerCreditApplied,
          pricing_snapshot: pricingSnapshot,
        },
        payload,
        request,
        checkoutFingerprint,
        claimToken: newPreferenceClaimToken,
        preferenceGeneration: 1,
        reservationExpiresAt,
      })
    } catch (preferenceError) {
      await releaseMercadoPagoPreferenceClaim(admin, order.id, newPreferenceClaimToken)
      throw preferenceError
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
      await releaseStoreBenefitClaimSafely(createAdminClient(), claimedBenefitId)
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

    if (error instanceof CheckoutReservationExpiredError) {
      return NextResponse.json(
        { code: "RESERVATION_EXPIRED", error: error.message },
        { status: 409 },
      )
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

async function releaseStoreBenefitClaimSafely(admin: AdminClient, benefitId: string) {
  try {
    await releaseStoreBenefitClaim(admin, benefitId)
  } catch (releaseError) {
    console.error("STORE_BENEFIT_RELEASE_FAILED", releaseError)
  }
}

const MERCADOPAGO_ATTEMPT_SELECT =
  "id, created_at, estado, total, financial_status, payment_status, payment_method_id, external_amount_due, credit_balance_used, cliente_email, cliente_nombre, mercadopago_checkout_fingerprint, mercadopago_reference, mercadopago_reference_assigned_at, mercadopago_init_point, mercadopago_preference_id, mercadopago_preference_expires_at, mercadopago_preference_claimed_at, mercadopago_preference_generation, installments_count, pricing_snapshot, store_benefit_id, andreani_creation_status, andreani_envio_id" as const

async function loadMercadoPagoCheckoutAttempts(
  admin: AdminClient,
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

/**
 * Orden 'pendiente' de esta misma compra según el índice único de
 * `customer_checkout_fingerprint` (usuario + carrito + envío/beneficio, SIN
 * precios -- por eso nunca alcanza por sí sola para reutilizarla).
 */
async function findPendingCustomerCheckoutOrder(
  admin: AdminClient,
  customerCheckoutFingerprint: string,
) {
  const { data, error } = await admin
    .from("ordenes")
    .select(MERCADOPAGO_ATTEMPT_SELECT)
    .eq("customer_checkout_fingerprint", customerCheckoutFingerprint)
    .eq("estado", "pendiente")
    .maybeSingle()

  if (error) {
    throw new Error(
      error.message || "No se pudo verificar la compra en curso.",
    )
  }

  return data as MercadoPagoCheckoutOrderRow | null
}

/**
 * Decide qué hacer con la orden pendiente de esta misma compra encontrada
 * por `customer_checkout_fingerprint`:
 * - económicamente idéntica -> misma decisión que un reintento (reuse /
 *   claim_preference / in_progress / already_paid): dos pestañas siguen
 *   siendo idempotentes;
 * - económicamente distinta -> NUNCA se reutiliza: se da de baja de forma
 *   segura y se devuelve `null` para crear una orden nueva con los valores
 *   actuales (o se responde "en proceso"/"ya pagada" si no se puede).
 */
async function resolvePendingCustomerCheckoutOrder({
  client,
  admin,
  order,
  payload,
  request,
  economicFingerprint,
}: {
  client: MercadoPagoConfig
  admin: AdminClient
  order: MercadoPagoCheckoutOrderRow
  payload: CheckoutPayload
  request: Request
  economicFingerprint: string
}): Promise<Response | null> {
  const action = getPendingCustomerCheckoutOrderAction(order, economicFingerprint)

  if (action === "other_payment_method") {
    return NextResponse.json(
      { error: ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE },
      { status: 409 },
    )
  }

  if (action === "resume_equivalent") {
    const response = await resolveMercadoPagoOrderAttempt({
      client,
      admin,
      order,
      payload,
      request,
      economicFingerprint,
    })
    return (
      response ??
      NextResponse.json({ error: ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE }, { status: 409 })
    )
  }

  const result = await supersedeStaleMercadoPagoOrder(admin, order, {
    dependencies: createMercadoPagoSupersedeDependencies(),
    currentEconomicFingerprint: economicFingerprint,
  })

  switch (result) {
    case "superseded":
      return null
    case "already_paid":
      return NextResponse.json({ error: ALREADY_PAID_MESSAGE }, { status: 409 })
    case "payment_in_process":
      return NextResponse.json(
        {
          error:
            "Tenés un pago de Mercado Pago en proceso para esta compra. Esperá a que se resuelva antes de iniciar otro.",
        },
        { status: 409 },
      )
    case "busy":
      return checkoutAttemptInProgressResponse()
    default:
      return NextResponse.json(
        { error: ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE },
        { status: 409 },
      )
  }
}

/**
 * Aplica `getMercadoPagoCheckoutAttemptDecision` a una orden MP existente y
 * devuelve la respuesta HTTP correspondiente, o `null` si no es reusable ni
 * bloqueante por sí misma (`unavailable`). Exige equivalencia económica
 * exacta: una orden con otro estado económico nunca se reutiliza ni se le
 * genera una preferencia nueva con su monto viejo.
 */
async function resolveMercadoPagoOrderAttempt({
  client,
  admin,
  order,
  payload,
  request,
  economicFingerprint,
}: {
  client: MercadoPagoConfig
  admin: AdminClient
  order: MercadoPagoCheckoutOrderRow
  payload: CheckoutPayload
  request: Request
  economicFingerprint: string
}): Promise<Response | null> {
  const decision = getMercadoPagoCheckoutAttemptDecision(order)

  if (decision.kind === "already_paid") {
    return NextResponse.json({ error: ALREADY_PAID_MESSAGE }, { status: 409 })
  }

  if (!isEconomicallyEquivalentAttempt(order, economicFingerprint)) {
    return null
  }

  const reservationExpiresAt = await loadMercadoPagoReservationDeadline(admin, order.id)

  if (decision.kind === "reuse") {
    return NextResponse.json({
      init_point: decision.initPoint,
      order_id: order.id,
      reused: true,
    })
  }

  if (decision.kind === "in_progress") {
    return checkoutAttemptInProgressResponse()
  }

  if (decision.kind !== "claim_preference") {
    return null
  }

  // La RPC exige que `p_checkout_fingerprint` coincida EXACTO con el valor
  // ya persistido en la orden (ver claim_mercadopago_order_preference) --
  // nunca el fingerprint recién calculado del request actual, que puede
  // diferir por sesión/contacto (otra pestaña) aunque la economía sea igual.
  const orderFingerprint = order.mercadopago_checkout_fingerprint
  if (!orderFingerprint) return null

  const claimToken = randomUUID()
  const { data: generation, error: claimError } = await admin.rpc(
    "claim_mercadopago_order_preference",
    {
      p_order_id: order.id,
      p_checkout_fingerprint: orderFingerprint,
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
      client,
      admin,
      order,
      payload,
      request,
      checkoutFingerprint: orderFingerprint,
      claimToken,
      preferenceGeneration,
      reservationExpiresAt,
    })

    return NextResponse.json({
      init_point: result.initPoint,
      order_id: order.id,
      reused: true,
    })
  } catch (error) {
    await releaseMercadoPagoPreferenceClaim(admin, order.id, claimToken)
    throw error
  }
}

async function releaseMercadoPagoPreferenceClaim(
  admin: AdminClient,
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
  reservationExpiresAt,
}: {
  client: MercadoPagoConfig
  admin: AdminClient
  order: MercadoPagoCheckoutOrderRow
  payload: CheckoutPayload
  request: Request
  checkoutFingerprint: string
  claimToken: string
  preferenceGeneration: number
  reservationExpiresAt: string
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
  // external_reference = order:<uuid>, nunca el id numérico (reutilizable).
  // Las órdenes nuevas ya traen el UUID; a una orden legada se le asigna acá,
  // antes de emitir la preferencia (ver ensureMercadoPagoOrderReference).
  const orderReference = await ensureMercadoPagoOrderReference(admin, order)
  const externalReference = getMercadoPagoOrderExternalReference(orderReference)
  const createdAt = new Date()
  const expiresAt = getMercadoPagoReservationPreferenceExpiration(reservationExpiresAt, createdAt)
  if (!expiresAt) throw new CheckoutReservationExpiredError()
  const preference = new Preference(client)
  // payment_methods.installments SIEMPRE explícito y derivado de lo
  // persistido en la orden (nunca del request): al contado = 1 (Checkout
  // Pro no puede financiar el precio de contado); en cuotas = cuota máxima
  // elegible del carrito, y el cliente elige dentro de Mercado Pago.
  const paymentMethods = getMercadoPagoPreferenceInstallments(order)
  const result = await preference.create({
    body: {
      external_reference: externalReference,
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
      payment_methods: paymentMethods,
      back_urls: {
        success: `${siteUrl}/checkout/success`,
        failure: `${siteUrl}/checkout/failure`,
        pending: `${siteUrl}/checkout/pending`,
      },
      expires: true,
      expiration_date_from: createdAt.toISOString(),
      expiration_date_to: expiresAt.toISOString(),
      date_of_expiration: expiresAt.toISOString(),
      notification_url: `${siteUrl}/api/mercadopago/webhook?source_news=webhooks`,
      metadata: {
        flow: "checkout_order",
        order_id: order.id,
        order_reference: orderReference.mercadopago_reference,
        checkout_fingerprint: checkoutFingerprint,
      },
    },
    requestOptions: {
      idempotencyKey: `beyonix-order-${orderReference.mercadopago_reference}-preference-${preferenceGeneration}`,
    },
  })

  if (!result.init_point || !result.id) {
    throw new Error("Mercado Pago no devolvió una preferencia válida.")
  }
  if (Date.now() >= expiresAt.getTime()) {
    try {
      await expireMercadoPagoPreference(result.id, new Date())
    } catch (expirationError) {
      console.error("MERCADOPAGO_PREFERENCE_EXPIRED_BEFORE_PERSIST", expirationError)
    }
    throw new CheckoutReservationExpiredError()
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
    try {
      await expireMercadoPagoPreference(result.id, new Date())
    } catch (expirationError) {
      console.error("MERCADOPAGO_UNPERSISTED_PREFERENCE_EXPIRE_ERROR", expirationError)
    }
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

async function loadMercadoPagoReservationDeadline(admin: AdminClient, orderId: number) {
  const { data, error } = await admin.from("checkout_reservation_sessions")
    .select("expires_at")
    .eq("order_id", orderId)
    .maybeSingle()
  if (error || !data?.expires_at || Date.parse(data.expires_at) - Date.now() < 60_000) {
    throw new CheckoutReservationExpiredError()
  }
  return data.expires_at
}

async function enforceMercadoPagoCheckoutRateLimits({
  admin,
  userId,
  requestFingerprint,
}: {
  admin: AdminClient
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
