import { NextResponse } from "next/server"

import {
  CheckoutShippingQuoteError,
} from "@/lib/cart/checkout-shipping"
import { AndreaniError } from "@/lib/andreani/client"
import { calculateCartTotals } from "@/lib/cart/cart-totals"
import { STOCK_CHANGED_MESSAGE } from "@/lib/cart/stock-status"
import { normalizeMoney, roundMoney } from "@/lib/customer-credit"
import {
  applyCustomerCreditToOrder,
  getCustomerCreditBalance,
} from "@/lib/customer-credit/server"
import { TRANSFER_ALIAS } from "@/lib/payments/transfer"
import {
  buildTransferEconomicState,
  calculateTransferCheckoutPricing,
} from "@/lib/payments/transfer-checkout"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { createGuestOrderAccessToken } from "@/lib/orders/guest-order-token"
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
  type CheckoutOrderPricingSnapshot,
  type CheckoutOrderRequestPayload,
  CHECKOUT_TERMS_NOT_ACCEPTED_MESSAGE,
  hasAcceptedCheckoutTerms,
} from "@/lib/orders/checkout-order-creation"
import {
  createTransferEconomicFingerprint,
  getPendingTransferCheckoutAction,
  getTransferCheckoutIdempotencyKey,
  supersedeStaleTransferOrder,
  type PendingCheckoutOrderRow,
} from "@/lib/orders/transfer-checkout-attempt"
import {
  createMercadoPagoSupersedeDependencies,
  supersedeStaleMercadoPagoOrder,
  type SupersedableMercadoPagoOrder,
} from "@/lib/mercadopago/checkout-supersede"
import {
  MissingReservationSessionError,
  normalizeReservationSessionId,
} from "@/lib/orders/checkout-inventory"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { getSiteSettings } from "@/lib/site-settings"
import {
  claimActiveStoreBenefit,
  findCheckoutStoreBenefit,
  linkStoreBenefitToOrder,
  releaseStoreBenefitClaim,
  type CheckoutStoreBenefitPreview,
} from "@/lib/customer-store-benefits"

type CheckoutPayload = CheckoutOrderRequestPayload
type AdminClient = ReturnType<typeof createAdminClient>
type PendingOrder = PendingCheckoutOrderRow & SupersedableMercadoPagoOrder

const ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE =
  "Ya tenés otra compra en curso con estos mismos productos. Continuá con esa compra o cancelala antes de iniciar una nueva."
const ORDER_BEING_CREATED_MESSAGE =
  "El pedido ya se está creando. Esperá unos segundos y volvé a intentarlo."

const PENDING_ORDER_SELECT =
  "id, estado, usuario_id, total, external_amount_due, credit_balance_used, payment_method_id, payment_status, financial_status, payment_proof_url, payment_proof_uploaded_at, transfer_verification_status, transfer_amount_declared, store_benefit_id, checkout_idempotency_key, pricing_snapshot, installments_count, mercadopago_checkout_fingerprint, mercadopago_init_point, mercadopago_preference_id, mercadopago_preference_expires_at, mercadopago_preference_claimed_at, andreani_creation_status, andreani_envio_id"

function normalizeExpectedTotal(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? roundMoney(value)
    : null
}

/**
 * Crea el pedido por transferencia. El servidor es la fuente de verdad: en
 * cada click recalcula todo con datos actuales (catálogo, envío, beneficio,
 * saldo, % de transferencia) y arma una huella económica. Un pedido
 * pendiente previo de la MISMA compra:
 * - con la misma huella -> se devuelve ese mismo pedido (doble click, dos
 *   pestañas, reintento): nunca se duplica;
 * - con otra huella (precio/envío/descuento cambió) o un intento de Mercado
 *   Pago -> se da de baja de forma segura si no tiene ningún rastro de pago,
 *   y se continúa con el total actual; nunca bloquea indefinidamente.
 */
export async function POST(request: Request) {
  const admin = createAdminClient()
  let claimedBenefitId: string | null = null

  try {
    const payload = (await request.json()) as CheckoutPayload
    if (!hasAcceptedCheckoutTerms(payload)) {
      return NextResponse.json(
        { code: "TERMS_NOT_ACCEPTED", error: CHECKOUT_TERMS_NOT_ACCEPTED_MESSAGE },
        { status: 400 },
      )
    }
    const checkoutSessionId = normalizeReservationSessionId(
      payload.reservationSessionId,
    )
    const items = normalizeCheckoutOrderItems(payload.items)
    const customer = normalizeCheckoutOrderCustomer(payload.customer)
    const customerError = getCheckoutOrderCustomerValidationError(customer)

    // Sin sesión de carrito no se puede reservar stock, y sin reserva el
    // pedido puede pisar unidades de otro checkout en curso.
    if (!checkoutSessionId) {
      return NextResponse.json(
        { error: "La sesión del carrito venció. Actualizá la página." },
        { status: 400 },
      )
    }

    if (!items.length) {
      return NextResponse.json({ error: "El carrito esta vacio." }, { status: 400 })
    }

    if (customerError) {
      return NextResponse.json({ error: customerError }, { status: 400 })
    }

    const supabase = await createClient()
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
    const siteSettings = await getSiteSettings({ fresh: true })
    const transferDiscountPercent = siteSettings.pricing.transferDiscountPercent
    const nationalTaxesIncidencePercent =
      siteSettings.pricing.nationalTaxesIncidencePercent
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
    const totals = calculateCartTotals(catalog.cartRows, {
      shippingCost: shipping.shipping_cost_charged,
    })

    // ── Beneficio (leído SIN reclamar) y pedido pendiente de esta compra ──
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

    let customerCheckoutFingerprint = customerFingerprintFor(benefitPreview?.id ?? null)
    let pendingOrder = customerCheckoutFingerprint
      ? await findPendingCheckoutOrder(admin, customerCheckoutFingerprint)
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
          ? await findPendingCheckoutOrder(admin, customerCheckoutFingerprint)
          : null
      }
    }

    // ── Total actual (mismas fórmulas de siempre, lib/payments/transfer-checkout.ts) ──
    const pricing = calculateTransferCheckoutPricing({
      productsTotal: totals.productsTotal,
      shippingCharged: totals.shipping,
      storeBenefitPercent: storeBenefit?.percent ?? null,
      requestedCustomerCredit: requestedCredit,
      transferDiscountPercent,
      nationalTaxesIncidencePercent,
    })

    if (pricing.requestedCreditExceedsTotal) {
      return NextResponse.json(
        { error: "El saldo a favor disponible cambió. Revisá el total antes de pagar." },
        { status: 409 },
      )
    }

    if (pricing.externalAmountDue <= 0) {
      return NextResponse.json(
        { error: "El saldo cubre el total. Confirmá la compra con saldo a favor." },
        { status: 400 },
      )
    }

    // El total que vio el cliente sólo sirve para no registrar un pedido
    // por un monto distinto del que tenía en pantalla. Se corta antes de
    // cualquier efecto (baja de pedidos viejos, claims, inserts).
    const expectedTotal = normalizeExpectedTotal(payload.expectedTotal)
    if (
      expectedTotal != null &&
      Math.abs(expectedTotal - pricing.externalAmountDue) > 0.009
    ) {
      return NextResponse.json(
        {
          code: "PRICING_CHANGED",
          error:
            "Los precios o condiciones de tu compra se actualizaron. Revisá el nuevo total antes de confirmar.",
          total: pricing.externalAmountDue,
        },
        { status: 409 },
      )
    }

    const economicFingerprint = createTransferEconomicFingerprint(
      buildTransferEconomicState({
        lines: catalog.cartRows.map((row, index) => ({
          productId: items[index].productId,
          variantId: items[index].variantId,
          conditionedStockId: items[index].conditionedStockId,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
        })),
        shipping: {
          provider: normalizedShipping.provider,
          type: normalizedShipping.type,
          sucursalId: shippingBranch?.id ?? null,
          costReal: normalizedShipping.costReal,
          costCharged: normalizedShipping.costCharged,
          freeShippingApplied: normalizedShipping.freeShippingApplied,
        },
        customer: { ...customer },
        storeBenefit: storeBenefit
          ? { id: storeBenefit.id, percent: storeBenefit.percent }
          : null,
        requestedCustomerCredit: requestedCredit,
        pricing,
        nationalTaxesIncidencePercent,
      }),
    )

    // ── Pedido pendiente previo de esta misma compra ──
    let supersededOrder: PendingOrder | null = null
    if (pendingOrder) {
      const response = await resolvePendingOrder(admin, pendingOrder, economicFingerprint)
      if (response) return response
      supersededOrder = pendingOrder
    }

    // ── Reclamos atómicos: el estado real tiene que seguir siendo el calculado ──
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
          error: "Tu beneficio ya no está disponible. Revisá el total antes de confirmar.",
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

    const pricingSnapshot: CheckoutOrderPricingSnapshot = {
      ...pricing.pricingSnapshot,
      economicFingerprint,
    }
    const orderPayload = {
      ...buildCheckoutOrderBase({
        userId: user?.id ?? null,
        total: pricing.transferTotal,
        externalAmountDue: pricing.externalAmountDue,
        creditBalanceUsed: pricing.customerCreditApplied,
        paymentMethodId: "transferencia",
        reservationSessionId: checkoutSessionId,
        storeBenefit: claimedBenefit,
        storeBenefitDiscountAmount: pricing.storeBenefitDiscountAmount,
        customer,
        pricingSnapshot,
      }),
      checkout_idempotency_key: getTransferCheckoutIdempotencyKey(
        checkoutSessionId,
        supersededOrder,
      ),
      customer_checkout_fingerprint: customerCheckoutFingerprint,
      envio_proveedor: shipping.shipping_provider,
      andreani_costo: shipping.shipping_cost_charged,
      payment_method_id: "transferencia",
      payment_type_id: null,
      payment_status: "pendiente_comprobante",
      transfer_alias: TRANSFER_ALIAS,
      transfer_discount_percent: transferDiscountPercent,
      transfer_discount_amount: pricing.transferDiscountAmount,
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
      console.error("TRANSFER_CREATE_ORDER_SUPABASE_ERROR", {
        message: orderError?.message,
        details: orderError?.details,
        hint: orderError?.hint,
        code: orderError?.code,
      })

      if (claimedBenefitId) {
        await releaseStoreBenefitClaimSafely(admin, claimedBenefitId)
        claimedBenefitId = null
      }

      if (isDuplicateCustomerCheckoutAttempt(orderError)) {
        // Carrera (doble click / dos pestañas): otro request creó el pedido
        // de esta misma compra entre la búsqueda y este INSERT. Si es
        // idéntico, se devuelve ese; nunca se duplica ni se da de baja acá.
        const conflictOrder = customerCheckoutFingerprint
          ? await findPendingCheckoutOrder(admin, customerCheckoutFingerprint)
          : null

        if (
          conflictOrder &&
          getPendingTransferCheckoutAction(conflictOrder, economicFingerprint) ===
            "resume_equivalent"
        ) {
          return existingTransferOrderResponse(conflictOrder)
        }

        return NextResponse.json(
          { error: ORDER_BEING_CREATED_MESSAGE },
          { status: 409, headers: { "Retry-After": "3" } },
        )
      }

      if (orderError?.code === "23505") {
        return NextResponse.json(
          { error: ORDER_BEING_CREATED_MESSAGE },
          { status: 409, headers: { "Retry-After": "3" } },
        )
      }

      throw new Error(orderError?.message || "No se pudo crear la orden.")
    }

    await insertCheckoutOrderItemsAndValidateInventory({
      orderClient,
      admin,
      orderId: order.id,
      items,
      products: catalog.products,
      conditionedRows: catalog.conditionedRows,
      reservationSessionId: checkoutSessionId,
      insertErrorMessage: "No se pudieron crear los items de la orden.",
    })

    if (user && pricing.customerCreditApplied > 0) {
      await applyCustomerCreditToOrder(admin, {
        userId: user.id,
        orderId: order.id,
        amount: pricing.customerCreditApplied,
        description: `Saldo a favor aplicado al pedido BX-${1000 + order.id}`,
        sourceKey: `order:${order.id}:customer-credit:debit`,
      })
    }

    if (claimedBenefit) {
      await linkStoreBenefitToOrder(admin, {
        benefitId: claimedBenefit.id,
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

    if (claimedBenefitId) {
      // Best-effort: si ya se vinculó a una orden real (used_order_id no es
      // null), releaseStoreBenefitClaim es un no-op por su propio guard --
      // nunca reactiva un cupón que sí terminó usándose.
      await releaseStoreBenefitClaimSafely(admin, claimedBenefitId)
    }

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
            : "No pudimos registrar el pedido por transferencia.",
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

async function findPendingCheckoutOrder(
  admin: AdminClient,
  customerCheckoutFingerprint: string,
) {
  const { data, error } = await admin
    .from("ordenes")
    .select(PENDING_ORDER_SELECT)
    .eq("customer_checkout_fingerprint", customerCheckoutFingerprint)
    .eq("estado", "pendiente")
    .maybeSingle()

  if (error) {
    throw new Error(error.message || "No se pudo verificar la compra en curso.")
  }

  return data as PendingOrder | null
}

/**
 * El pedido pendiente de la misma compra sólo corresponde a usuarios
 * autenticados (`customer_checkout_fingerprint` es null para invitados), así
 * que nunca hace falta un token de invitado para devolverlo.
 */
function existingTransferOrderResponse(order: Pick<PendingOrder, "id">) {
  return NextResponse.json({
    order_id: order.id,
    redirect_url: `/checkout/success?method=transferencia&order_id=${order.id}`,
    guest_token: null,
    reused: true,
  })
}

/**
 * Devuelve la respuesta si el pedido pendiente resuelve la request (mismo
 * pedido, o no se puede dar de baja), o `null` si se dio de baja y hay que
 * crear el pedido nuevo con los valores actuales.
 */
async function resolvePendingOrder(
  admin: AdminClient,
  order: PendingOrder,
  economicFingerprint: string,
): Promise<Response | null> {
  const action = getPendingTransferCheckoutAction(order, economicFingerprint)

  if (action === "resume_equivalent") {
    return existingTransferOrderResponse(order)
  }

  if (action === "other_payment_method") {
    return NextResponse.json(
      { error: ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE },
      { status: 409 },
    )
  }

  if (action === "mercadopago_attempt") {
    const result = await supersedeStaleMercadoPagoOrder(admin, order, {
      dependencies: createMercadoPagoSupersedeDependencies(),
      currentEconomicFingerprint: economicFingerprint,
    })

    switch (result) {
      case "superseded":
        return null
      case "already_paid":
        return NextResponse.json(
          { error: "Esta compra ya fue pagada con Mercado Pago." },
          { status: 409 },
        )
      case "payment_in_process":
        return NextResponse.json(
          {
            error:
              "Tenés un pago de Mercado Pago en proceso para esta compra. Esperá a que se resuelva antes de elegir transferencia.",
          },
          { status: 409 },
        )
      case "busy":
        return NextResponse.json(
          { error: ORDER_BEING_CREATED_MESSAGE },
          { status: 409, headers: { "Retry-After": "3" } },
        )
      default:
        return NextResponse.json(
          { error: ANOTHER_PURCHASE_IN_PROGRESS_MESSAGE },
          { status: 409 },
        )
    }
  }

  const result = await supersedeStaleTransferOrder(admin, order, {
    currentEconomicFingerprint: economicFingerprint,
  })

  if (result === "superseded") return null

  if (result === "payment_in_review") {
    return NextResponse.json(
      {
        error:
          "Ya tenés un pedido por transferencia de esta compra con un pago informado. Continuá con ese pedido desde Mis compras.",
      },
      { status: 409 },
    )
  }

  return NextResponse.json(
    { error: ORDER_BEING_CREATED_MESSAGE },
    { status: 409, headers: { "Retry-After": "3" } },
  )
}
