import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { buildArcaQrUrl } from "@/lib/arca/qr"
import { FACTURA_C_TYPE, NOTA_CREDITO_C_TYPE } from "@/lib/arca/wsfe"
import { emitCreditNote, type CreditNoteArcaResult } from "@/lib/arca/credit-note-emission"
import { getArcaPointOfSale } from "@/lib/arca/invoice-automation"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"
import { finalizeCreditNote } from "@/lib/orders/credit-note-finalization"
import {
  canProceedPastProductsStep,
} from "@/lib/orders/credit-note-wizard"
import {
  getCreditNoteClaimPolicyError,
  isAdministrativeCreditNoteOperation,
} from "@/lib/orders/credit-note-claim-policy"
import {
  allocateEffectiveOrderItemAmounts,
  calculatePartialLineAmount,
  roundCreditMoney,
} from "@/lib/orders/credit-note-calculations"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import { normalizeStockDestination } from "@/lib/orders/return-reception"
import {
  getAvailableToCreditQuantity,
  getReceptionApprovalGateError,
  getReceptionExceptionError,
} from "@/lib/orders/credit-note-reception"

export const runtime = "nodejs"

type CreditNoteDestination = "external_refund" | "customer_balance"
type CreditNoteRequest = {
  items?: Array<{ order_item_id?: unknown; quantity?: unknown }>
  operation_type?: unknown
  destination?: unknown
  reason?: unknown
  reason_code?: unknown
  reason_detail?: unknown
  include_original_shipping?: unknown
  other_adjustment_amount?: unknown
  return_shipping_party?: unknown
  return_shipping_provider?: unknown
  return_shipping_tracking?: unknown
  return_shipping_cost?: unknown
  new_shipping_party?: unknown
  new_shipping_cost?: unknown
  reception_status?: unknown
  reception_exception?: unknown
  reception_exception_reason?: unknown
  reception_date?: unknown
  reception_notes?: unknown
  physical_condition?: unknown
  accessories_complete?: unknown
  original_packaging?: unknown
  stock_destination?: unknown
  conditioned_discount_percent?: unknown
  claim_id?: unknown
  expected_note_ids?: unknown
}

const OPERATION_TYPES = [
  "devolucion_parcial",
  "devolucion_total",
  "cambio_producto",
  "cancelacion_antes_despacho",
  "reembolso_excepcional",
  "ajuste_manual",
] as const
const REASON_CODES = [
  "arrepentimiento",
  "producto_defectuoso",
  "producto_incorrecto",
  "producto_faltante",
  "producto_danado_envio",
  "garantia_aprobada",
  "cancelacion_antes_despacho",
  "error_administrativo",
  "otro",
] as const
const RECEPTION_STATUSES = [
  "no_requiere",
  "pendiente_despacho",
  "en_transito",
  "recibido_revision",
  "producto_aprobado",
  "producto_rechazado",
  "aprobado_parcial",
] as const
const SHIPPING_PARTIES = ["cliente", "beyonix", "no_corresponde"] as const
const STOCK_DESTINATIONS = [
  "stock_vendible",
  "stock_observaciones",
  "fallado",
  "garantia_proveedor",
  "no_reingresar",
  "pendiente_revision",
] as const

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  fallback: T,
) {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fallback
}

function optionalText(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength) || null
    : null
}

function safeMoney(value: unknown) {
  const amount = roundCreditMoney(Number(value ?? 0))
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function argentinaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    arca: `${value.year}${value.month}${value.day}`,
    iso: `${value.year}-${value.month}-${value.day}`,
  }
}

function isoDateToArca(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : argentinaDate(date).arca
}

function reservationError(message?: string) {
  const knownErrors: Record<string, string> = {
    CREDIT_NOTE_PROCESSING_IN_PROGRESS:
      "Hay otra nota de crédito comunicándose con ARCA. Esperá un momento y reintentá.",
    CREDIT_NOTE_EXCEEDS_INVOICE:
      "El monto supera el saldo disponible de la factura.",
    CREDIT_NOTE_ITEM_QUANTITY_EXCEEDED:
      "Una cantidad supera las unidades disponibles para acreditar.",
    AUTHORIZED_INVOICE_REQUIRED:
      "La orden no tiene una Factura C autorizada para asociar.",
    INVALID_CREDIT_NOTE_CLAIM:
      "El reclamo seleccionado no corresponde a este pedido.",
    CLAIM_REQUIRED:
      "Esta gestión requiere un reclamo del cliente para el pedido. Iniciá el reclamo antes de emitir la devolución.",
    INVALID_CREDIT_NOTE_CLAIM_STATUS:
      "El reclamo no está habilitado para esta devolución o reintegro.",
    INVALID_CREDIT_NOTE_CLAIM_ITEM:
      "La nota incluye productos o cantidades que no forman parte del reclamo.",
    CREDIT_NOTE_ADMIN_OPERATION_FORBIDDEN:
      "Solo un superadministrador puede emitir una nota administrativa sin reclamo.",
    CREDIT_NOTE_ADMIN_ITEMS_FORBIDDEN:
      "Un ajuste administrativo sin reclamo no puede incluir productos.",
    CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT:
      "El importe supera lo que todavía falta devolver en dinero externo para este pedido. Si usó saldo a favor, esa parte ya se reintegró automáticamente.",
    ORDER_ALREADY_REFUNDED:
      "Este pedido ya fue reintegrado. No se puede emitir otra nota de crédito que mueva dinero.",
  }
  const entry = Object.entries(knownErrors).find(([code]) =>
    message?.includes(code),
  )
  return entry?.[1] ?? "No se pudo reservar la emisión de la nota de crédito."
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Orden inválida." }, { status: 400 })
  }

  let body: CreditNoteRequest
  try {
    body = (await request.json()) as CreditNoteRequest
  } catch {
    return NextResponse.json(
      { error: "Completá el detalle de la nota de crédito." },
      { status: 400 },
    )
  }

  const destination = body.destination as CreditNoteDestination
  const operationType = enumValue(
    body.operation_type,
    OPERATION_TYPES,
    "devolucion_parcial",
  )
  const reasonCode = enumValue(body.reason_code, REASON_CODES, "otro")
  const reasonDetail = optionalText(body.reason_detail, 500)
  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  const storedReason = reason || reasonDetail || reasonCode
  const otherAdjustmentAmount = safeMoney(body.other_adjustment_amount)
  const returnShippingCost = safeMoney(body.return_shipping_cost)
  const newShippingCost = safeMoney(body.new_shipping_cost)
  const includeOriginalShipping = body.include_original_shipping === true
  const returnShippingParty = enumValue(
    body.return_shipping_party,
    SHIPPING_PARTIES,
    "cliente",
  )
  const newShippingParty = enumValue(
    body.new_shipping_party,
    SHIPPING_PARTIES,
    "no_corresponde",
  )
  const receptionStatus = enumValue(
    body.reception_status,
    RECEPTION_STATUSES,
    "pendiente_despacho",
  )
  const receptionException = body.reception_exception === true
  const stockDestinationInput = enumValue(
    body.stock_destination,
    STOCK_DESTINATIONS,
    "pendiente_revision",
  )
  // Un destino de stock solo tiene sentido cuando hubo recepcion fisica; en
  // cualquier otro caso se normaliza para no persistir un valor stale que
  // el motor de stock jamas va a leer.
  const stockDestination = normalizeStockDestination(receptionStatus, stockDestinationInput)

  const conditionedDiscountPercent = Number(body.conditioned_discount_percent)
  const claimIdValue = Number(body.claim_id)
  const claimId =
    Number.isInteger(claimIdValue) && claimIdValue > 0 ? claimIdValue : null

  if (!["external_refund", "customer_balance"].includes(destination)) {
    return NextResponse.json(
      { error: "Seleccioná qué ocurrirá con el importe autorizado." },
      { status: 400 },
    )
  }
  if (reason.length > 120) {
    return NextResponse.json(
      { error: "El motivo no puede superar los 120 caracteres." },
      { status: 400 },
    )
  }
  if (reasonCode === "otro" && !reasonDetail && !reason) {
    return NextResponse.json(
      { error: "Detallá el motivo cuando seleccionás “Otro”." },
      { status: 400 },
    )
  }
  if (
    otherAdjustmentAmount === null ||
    returnShippingCost === null ||
    newShippingCost === null
  ) {
    return NextResponse.json(
      { error: "Revisá los importes de la gestión." },
      { status: 400 },
    )
  }
  if (
    stockDestination === "stock_observaciones" &&
    (!Number.isFinite(conditionedDiscountPercent) ||
      conditionedDiscountPercent <= 0 ||
      conditionedDiscountPercent >= 100)
  ) {
    return NextResponse.json(
      { error: "Indicá un descuento entre 0% y 100% para el stock con observaciones." },
      { status: 400 },
    )
  }
  if (
    receptionStatus === "producto_rechazado" &&
    !optionalText(body.reception_notes, 2000)
  ) {
    return NextResponse.json(
      { error: "Indicá el motivo por el que el producto fue rechazado." },
      { status: 400 },
    )
  }
  const receptionApproved = [
    "no_requiere",
    "producto_aprobado",
    "aprobado_parcial",
  ].includes(receptionStatus)
  const receptionExceptionReason = optionalText(body.reception_exception_reason, 500)
  const approvalGateError = getReceptionApprovalGateError(receptionApproved, receptionException)
  if (approvalGateError) {
    return NextResponse.json({ error: approvalGateError }, { status: 409 })
  }
  // Auditoría 4/7 (Fase 2, punto 5): reception_exception=true saltea la
  // exigencia de recepción física aprobada -- no puede ser una salida
  // fácil sin dejar rastro. Motivo obligatorio (queda auditado junto con
  // created_by/created_at, que ya identifican actor y fecha).
  const exceptionReasonError = getReceptionExceptionError(receptionException, receptionExceptionReason)
  if (exceptionReasonError) {
    return NextResponse.json({ error: exceptionReasonError }, { status: 400 })
  }

  const [{ data: order, error: orderError }, { data: orderItems, error: itemsError }] =
    await Promise.all([
      auth.admin
        .from("ordenes")
        .select(
          "id, usuario_id, total, estado, financial_status, credit_balance_used, andreani_costo, shipping_cost_charged, shipping_cost_real, invoice_status, invoice_cae, invoice_number, invoice_point, invoice_created_at, credit_note_status",
        )
        .eq("id", orderId)
        .single(),
      auth.admin
        .from("orden_items")
        .select("id, orden_id, producto_id, variante_id, conditioned_stock_id, conditioned_name, cantidad, precio")
        .eq("orden_id", orderId),
    ])

  if (orderError) {
    console.error("No se pudo consultar la orden para emitir la nota de crédito", {
      orderId,
      code: orderError.code,
      message: orderError.message,
    })
    return NextResponse.json(
      { error: "No se pudo consultar la orden para emitir la nota de crédito." },
      { status: 500 },
    )
  }
  if (!order) {
    return NextResponse.json({ error: "Orden no encontrada." }, { status: 404 })
  }
  if (itemsError) {
    return NextResponse.json(
      { error: "No se pudieron verificar los artículos del pedido." },
      { status: 500 },
    )
  }
  if (
    order.invoice_status !== "authorized" ||
    !order.invoice_cae ||
    !order.invoice_number ||
    !order.invoice_point
  ) {
    return NextResponse.json(
      { error: "La orden no tiene una Factura C autorizada para asociar." },
      { status: 409 },
    )
  }
  if (destination === "customer_balance" && !order.usuario_id) {
    return NextResponse.json(
      {
        error:
          "Este pedido no tiene una cuenta de cliente asociada para acreditar saldo.",
      },
      { status: 409 },
    )
  }

  const requestedItems = new Map<number, number>()
  for (const input of Array.isArray(body.items) ? body.items : []) {
    const itemId = Number(input.order_item_id)
    const quantity = Number(input.quantity)
    if (
      !Number.isInteger(itemId) ||
      itemId <= 0 ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      requestedItems.has(itemId)
    ) {
      return NextResponse.json(
        { error: "Revisá las cantidades seleccionadas." },
        { status: 400 },
      )
    }
    requestedItems.set(itemId, quantity)
  }

  const items = orderItems ?? []
  const originalShippingPaid = roundCreditMoney(
    Math.max(0, Number(order.shipping_cost_charged ?? 0)),
  )
  const originalShippingRefunded = includeOriginalShipping
    ? originalShippingPaid
    : 0
  if (includeOriginalShipping && originalShippingPaid <= 0) {
    return NextResponse.json(
      { error: "No se puede reintegrar un envío que el cliente no pagó." },
      { status: 409 },
    )
  }
  const manualAmount = roundCreditMoney(
    originalShippingRefunded + otherAdjustmentAmount,
  )
  const calculationOrder = {
    ...order,
    shipping_cost_charged: originalShippingPaid,
  }
  const allocations = new Map(
    allocateEffectiveOrderItemAmounts(calculationOrder, items).map((item) => [
      item.orderItemId,
      item,
    ]),
  )
  const matchedItems = items.filter((item) => requestedItems.has(Number(item.id)))
  const hasInvalidQuantity = matchedItems.some((item) => {
    const quantity = requestedItems.get(Number(item.id)) ?? 0
    return !allocations.has(Number(item.id)) || quantity > Number(item.cantidad)
  })
  if (hasInvalidQuantity) {
    return NextResponse.json(
      { error: "Una cantidad supera las unidades vendidas." },
      { status: 400 },
    )
  }
  const selectedBase = matchedItems.map((item) => {
      const quantity = requestedItems.get(Number(item.id)) ?? 0
      const allocation = allocations.get(Number(item.id))!
      return {
        item,
        quantity,
        allocation,
        totalAmount: calculatePartialLineAmount(allocation, quantity),
      }
    })

  if (selectedBase.length !== requestedItems.size) {
    return NextResponse.json(
      { error: "Uno de los artículos no pertenece al pedido." },
      { status: 400 },
    )
  }
  const productIds = [...new Set(selectedBase.map(({ item }) => item.producto_id))]
  const variantIds = [
    ...new Set(
      selectedBase
        .map(({ item }) => item.variante_id)
        .filter((value): value is number => typeof value === "number"),
    ),
  ]
  const [productsResult, variantsResult] = await Promise.all([
    productIds.length
      ? auth.admin
          .from("productos")
          .select("id, nombre")
          .in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? auth.admin
          .from("producto_variantes")
          .select("id, nombre")
          .in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  if (productsResult.error || variantsResult.error) {
    return NextResponse.json(
      { error: "No se pudo preparar el detalle comercial." },
      { status: 500 },
    )
  }
  const productNames = new Map(
    (productsResult.data ?? []).map((product) => [Number(product.id), product.nombre]),
  )
  const variantNames = new Map(
    (variantsResult.data ?? []).map((variant) => [Number(variant.id), variant.nombre]),
  )
  const selectedItems = selectedBase.map(
    ({ item, quantity, allocation, totalAmount }) => ({
      order_item_id: Number(item.id),
      quantity,
      unit_amount: allocation.effectiveUnitAmount,
      total_amount: totalAmount,
      product_name:
        productNames.get(Number(item.producto_id)) ?? `Artículo #${item.producto_id}`,
      variant_name:
        typeof item.conditioned_name === "string" &&
        item.conditioned_name.trim()
          ? item.conditioned_name
          : typeof item.variante_id === "number"
          ? variantNames.get(item.variante_id) ?? ""
          : "",
    }),
  )
  const itemsAmount = roundCreditMoney(
    selectedItems.reduce((sum, item) => sum + item.total_amount, 0),
  )
  const totalAmount = roundCreditMoney(itemsAmount + manualAmount)

  if (totalAmount <= 0) {
    return NextResponse.json(
      { error: "Seleccioná al menos un artículo o ingresá un ajuste manual." },
      { status: 400 },
    )
  }

  const selectedUnits = selectedItems.reduce((sum, item) => sum + item.quantity, 0)
  if (!canProceedPastProductsStep(operationType, selectedUnits)) {
    return NextResponse.json(
      {
        error:
          "Este tipo de gestión requiere seleccionar al menos un producto.",
      },
      { status: 400 },
    )
  }
  const { data: selectedClaim, error: claimError } = claimId
    ? await auth.admin
        .from("order_claims")
        .select("id, order_id, user_id, status, failure_type, resolution, affected_items")
        .eq("id", claimId)
        .maybeSingle()
    : { data: null, error: null }
  if (claimError) {
    return NextResponse.json(
      { error: "No se pudo validar el reclamo asociado." },
      { status: 500 },
    )
  }
  const claimPolicyError = getCreditNoteClaimPolicyError({
    operationType,
    actorRole: auth.profile.rol,
    orderId,
    orderUserId: order.usuario_id,
    claim: selectedClaim,
    selectedItems,
  })
  if (claimPolicyError) {
    return NextResponse.json({ error: claimPolicyError }, { status: 409 })
  }
  if (isAdministrativeCreditNoteOperation(operationType) && reasonCode !== "error_administrativo") {
    return NextResponse.json(
      { error: "Los ajustes administrativos deben registrarse con motivo Error administrativo." },
      { status: 400 },
    )
  }
  const expectedNoteIds = body.expected_note_ids
  if (!Array.isArray(expectedNoteIds) || expectedNoteIds.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    return NextResponse.json({ error: "Actualizá la gestión fiscal antes de emitir la nota." }, { status: 409 })
  }

  // Auditoría 4/7 (Fase 2, punto 4): si ESTE ítem ya tiene una recepción
  // física registrada de una gestión anterior (inventory_return_movements),
  // la NC no puede acreditar más unidades que las que realmente se
  // recibieron menos lo ya comprometido por otras notas -- un admin
  // tipeando una cantidad mayor no puede generar crédito de más. No aplica
  // a la recepción que está ocurriendo en ESTA misma request (todavía no
  // existe la fila: se crea más abajo, después de autorizar la NC, con el
  // mismo número que se valida acá).
  if (selectedItems.length > 0 && !receptionException) {
    const orderItemIds = selectedItems.map((item) => item.order_item_id)
    const [{ data: priorReceptions, error: priorReceptionsError }, { data: committedNoteItems, error: committedError }] =
      await Promise.all([
        auth.admin
          .from("inventory_return_movements")
          .select("order_item_id, received_quantity")
          .in("order_item_id", orderItemIds),
        auth.admin
          .from("order_credit_note_items")
          .select("order_item_id, quantity, order_credit_notes!inner(status)")
          .in("order_item_id", orderItemIds)
          .in("order_credit_notes.status", ["processing", "authorized"]),
      ])
    if (priorReceptionsError || committedError) {
      return NextResponse.json(
        { error: "No se pudo verificar la recepción física ya registrada." },
        { status: 500 },
      )
    }
    const receivedByItem = new Map<number, number>()
    for (const row of priorReceptions ?? []) {
      const itemId = Number(row.order_item_id)
      receivedByItem.set(itemId, (receivedByItem.get(itemId) ?? 0) + Number(row.received_quantity ?? 0))
    }
    const committedByItem = new Map<number, number>()
    for (const row of committedNoteItems ?? []) {
      const itemId = Number(row.order_item_id)
      committedByItem.set(itemId, (committedByItem.get(itemId) ?? 0) + Number(row.quantity ?? 0))
    }
    for (const item of selectedItems) {
      const received = receivedByItem.get(item.order_item_id)
      if (received == null) continue // sin recepción previa: nada que cruzar todavía.
      const committed = committedByItem.get(item.order_item_id) ?? 0
      const availableToCredit = getAvailableToCreditQuantity(received, committed)
      if (item.quantity > availableToCredit) {
        return NextResponse.json(
          {
            error: `Este producto ya tiene una recepción física registrada: sólo quedan ${availableToCredit} unidad(es) disponibles para acreditar (de ${received} recibidas).`,
          },
          { status: 409 },
        )
      }
    }
  }

  let pointOfSale: number
  try {
    pointOfSale = getArcaPointOfSale()
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ARCA_PTO_VTA inválido." },
      { status: 500 },
    )
  }

  const { data: reservedNote, error: reservationFailure } = await auth.admin
    .rpc("begin_partial_credit_note", {
      p_order_id: orderId,
      p_claim_id: claimId,
      p_destination: destination,
      p_reason: storedReason,
      p_items_amount: itemsAmount,
      p_manual_amount: manualAmount,
      p_total_amount: totalAmount,
      p_invoice_point: Number(order.invoice_point),
      p_invoice_number: Number(order.invoice_number),
      p_created_by: auth.user.id,
      p_items: selectedItems,
      p_operation_type: operationType,
      p_expected_note_ids: expectedNoteIds,
    })
    .maybeSingle()

  if (reservationFailure || !reservedNote) {
    return NextResponse.json(
      { error: reservationFailure?.message === "CREDIT_NOTE_SNAPSHOT_CONFLICT" ? "La gestión fiscal cambió. Actualizá el pedido y revisá las notas emitidas antes de confirmar otra emisión." : reservationError(reservationFailure?.message) },
      { status: 409 },
    )
  }

  const noteId = String((reservedNote as { id: string }).id)
  const resolutionType =
    destination === "customer_balance"
      ? "saldo_favor"
      : operationType === "cambio_producto"
        ? "cambio_producto"
        : "medio_pago"
  const managementStatus =
    destination === "customer_balance"
      ? "nota_credito_pendiente"
      : "reembolso_pendiente"
  const { error: managementError } = await auth.admin
    .from("order_credit_notes")
    .update({
      operation_type: operationType,
      reason_code: reasonCode,
      reason_detail: reasonDetail,
      resolution_type: resolutionType,
      management_status: managementStatus,
      reception_status: receptionStatus,
      reception_exception: receptionException,
      reception_exception_reason: receptionException ? receptionExceptionReason : null,
      reception_date: optionalText(body.reception_date, 10),
      reception_notes: optionalText(body.reception_notes, 2000),
      physical_condition: optionalText(body.physical_condition, 500),
      accessories_complete:
        typeof body.accessories_complete === "boolean"
          ? body.accessories_complete
          : null,
      original_packaging: optionalText(body.original_packaging, 20),
      original_shipping_paid: originalShippingPaid,
      original_shipping_discounted: roundCreditMoney(
        Math.max(0, Number(order.shipping_cost_real ?? 0) - originalShippingPaid),
      ),
      original_shipping_refunded: originalShippingRefunded,
      return_shipping_party: returnShippingParty,
      return_shipping_provider: optionalText(body.return_shipping_provider, 120),
      return_shipping_tracking: optionalText(body.return_shipping_tracking, 180),
      return_shipping_cost: returnShippingCost,
      new_shipping_party: newShippingParty,
      new_shipping_cost: newShippingCost,
      other_adjustment_amount: otherAdjustmentAmount,
      stock_destination: stockDestination,
      conditioned_discount_percent:
        stockDestination === "stock_observaciones" ? conditionedDiscountPercent : null,
      settlement_status: "pendiente",
    })
    .eq("id", noteId)
    .eq("status", "processing")

  if (managementError) {
    await auth.admin
      .from("order_credit_notes")
      .update({
        status: "error",
        error: "No se pudo guardar la gestión comercial antes de contactar a ARCA.",
      })
      .eq("id", noteId)
    return NextResponse.json(
      { error: "No se pudo guardar la gestión. ARCA no fue contactada." },
      { status: 500 },
    )
  }
  const itemReception =
    receptionStatus === "producto_aprobado"
      ? {
          return_status: "recibido_correctamente",
          received: true,
          approved: true,
          rejected: false,
        }
      : receptionStatus === "aprobado_parcial"
        ? {
            return_status: "recibido_observaciones",
            received: true,
            approved: true,
            rejected: false,
          }
        : receptionStatus === "producto_rechazado"
          ? {
              return_status: "rechazado",
              received: true,
              approved: false,
              rejected: true,
            }
          : {
              return_status:
                receptionStatus === "no_requiere"
                  ? "resuelto"
                  : "pendiente_devolucion",
              received: false,
              approved: false,
              rejected: false,
            }
  const itemReceptionResults = await Promise.all(
    selectedItems.map((item) =>
      auth.admin
        .from("order_credit_note_items")
        .update({
          return_status: itemReception.return_status,
          received_quantity: itemReception.received ? item.quantity : 0,
          approved_quantity: itemReception.approved ? item.quantity : 0,
          rejected_quantity: itemReception.rejected ? item.quantity : 0,
        })
        .eq("credit_note_id", noteId)
        .eq("order_item_id", item.order_item_id),
    ),
  )
  if (itemReceptionResults.some((result) => result.error)) {
    await auth.admin
      .from("order_credit_notes")
      .update({
        status: "error",
        error: "No se pudo guardar la recepción antes de contactar a ARCA.",
      })
      .eq("id", noteId)
    return NextResponse.json(
      { error: "No se pudo guardar la recepción. ARCA no fue contactada." },
      { status: 500 },
    )
  }
  // Desde acá ARCA: servicio idempotente con reconciliación (una NC
  // autorizada nunca se emite dos veces) y finalización reanudable.
  const emission = await emitCreditNote(auth.admin, {
    noteId,
    gateway: createWsfeInvoiceGateway(),
    pointOfSale,
    associatedInvoice: {
      pointOfSale: Number(order.invoice_point),
      voucherNumber: Number(order.invoice_number),
      voucherDate: isoDateToArca(order.invoice_created_at),
    },
  })

  if (emission.status !== "authorized") {
    return creditNoteEmissionFailureResponse(emission, orderId, noteId)
  }

  const { authorization } = emission
  try {
    const finalized = await finalizeCreditNote(auth.admin, { noteId, actorId: auth.user.id })
    return NextResponse.json({
      order: { ...finalized.order, order_credit_notes: finalized.authorizedNotes },
      note: finalized.note,
      credit_note: {
        voucher_type: NOTA_CREDITO_C_TYPE,
        credit_note_number: String(authorization.voucherNumber),
        credit_note_point: authorization.pointOfSale,
        credit_note_cae: authorization.cae,
        credit_note_cae_due: authorization.caeDue,
        issue_date: authorization.issueDate,
        amount: totalAmount,
        reconciled: authorization.reconciled,
        associated_invoice: {
          voucher_type: FACTURA_C_TYPE,
          point: order.invoice_point,
          number: order.invoice_number,
        },
        qr_url: buildArcaQrUrl({
          issueDate: authorization.issueDate,
          cuit: process.env.ARCA_CUIT ?? "",
          pointOfSale: authorization.pointOfSale,
          voucherType: NOTA_CREDITO_C_TYPE,
          voucherNumber: authorization.voucherNumber,
          total: totalAmount,
          cae: authorization.cae,
        }),
      },
      customer_credit_movement: finalized.customerCreditMovement,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error posterior a la autorización."
    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "system",
      actorId: null,
      action: "credit_note_post_authorization_error",
      previousStatus: "authorized",
      newStatus: "authorized",
      metadata: { orderCreditNoteId: noteId, error: message },
    })
    console.error("Error posterior a la autorización de Nota de Crédito C", { orderId, noteId, error: message })
    return NextResponse.json(
      {
        error:
          "ARCA autorizó la nota de crédito, pero falló una acción posterior. El comprobante fiscal es válido: usá “Conciliar con ARCA” para completar la gestión sin emitir otra nota.",
        note_authorized: true,
        note_id: noteId,
      },
      { status: 500 },
    )
  }
}

function creditNoteEmissionFailureResponse(
  emission: Exclude<CreditNoteArcaResult, { status: "authorized" }>,
  orderId: number,
  noteId: string,
) {
  switch (emission.status) {
    case "busy":
      return NextResponse.json(
        { error: "Esta nota de crédito ya se está emitiendo. Esperá a que termine." },
        { status: 409 },
      )
    case "already_finalized":
      return NextResponse.json({ error: "La nota de crédito ya fue emitida." }, { status: 409 })
    case "released":
      return NextResponse.json({ error: emission.error }, { status: 409 })
    case "failed":
      console.error("Error al emitir Nota de Crédito C", { orderId, noteId, outcome: emission.outcome, error: emission.error })
      if (emission.outcome === "rejected") {
        return NextResponse.json(
          { error: "No se pudo emitir la nota de crédito. Revisá la gestión antes de reintentar.", detail: emission.error },
          { status: 502 },
        )
      }
      return NextResponse.json(
        {
          error:
            emission.outcome === "manual_review"
              ? "ARCA tiene ese comprobante con otros datos. Requiere revisión manual: no se emitió otra nota."
              : "El resultado de ARCA requiere conciliación. Usá “Conciliar con ARCA” antes de volver a emitir.",
          reconciliation_required: true,
          note_id: noteId,
        },
        { status: 409 },
      )
  }
}
