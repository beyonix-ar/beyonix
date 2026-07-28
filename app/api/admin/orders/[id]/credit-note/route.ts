import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { buildArcaQrUrl } from "@/lib/arca/qr"
import {
  ArcaWsError,
  FACTURA_C_TYPE,
  NOTA_CREDITO_C_TYPE,
  feCompConsultar,
  fecaeSolicitar,
  feCompUltimoAutorizado,
} from "@/lib/arca/wsfe"
import { creditCustomerForOrderCreditNote } from "@/lib/customer-credit/server"
import {
  allocateEffectiveOrderItemAmounts,
  calculatePartialLineAmount,
  roundCreditMoney,
} from "@/lib/orders/credit-note-calculations"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"

export const runtime = "nodejs"

type CreditNoteDestination = "external_refund" | "customer_balance"
type InventoryReturnMovement = {
  source_key: string
  order_id: number
  order_item_id: number
  product_id: number
  variant_id: number | null
  quantity: number
  approved_by: string
  approved_at: string
}

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
  reception_date?: unknown
  reception_notes?: unknown
  physical_condition?: unknown
  accessories_complete?: unknown
  original_packaging?: unknown
  stock_destination?: unknown
  claim_id?: unknown
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

function getPointOfSale() {
  const pointOfSale = Number(process.env.ARCA_PTO_VTA)
  if (!Number.isInteger(pointOfSale) || pointOfSale <= 0) {
    throw new Error("ARCA_PTO_VTA debe ser un entero mayor que cero.")
  }
  return pointOfSale
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

function arcaDateToIso(value: string) {
  if (!/^\d{8}$/.test(value)) {
    throw new Error("ARCA devolvió una fecha de vencimiento de CAE inválida.")
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function validateIssueDateAfterLastAuthorized(
  issueDate: string,
  lastAuthorizedDate?: string | null,
) {
  if (lastAuthorizedDate && issueDate < lastAuthorizedDate) {
    throw new Error(
      "La fecha del comprobante no puede ser anterior a la última autorizada por ARCA.",
    )
  }
}

function creditNoteErrorMessage(error: unknown) {
  if (error instanceof ArcaWsError && error.details.length) {
    return `${error.message} ${error.details
      .map((detail) => `${detail.Code}: ${detail.Msg}`)
      .join(" | ")}`
  }
  return error instanceof Error
    ? error.message
    : "No se pudo emitir la Nota de Crédito C."
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
  const stockDestination = enumValue(
    body.stock_destination,
    STOCK_DESTINATIONS,
    "pendiente_revision",
  )
  const claimIdValue = Number(body.claim_id)
  let claimId =
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
  if (!receptionApproved && !receptionException) {
    return NextResponse.json(
      {
        error:
          "La nota queda bloqueada hasta recibir y aprobar el producto. Usá la excepción administrativa únicamente si corresponde.",
      },
      { status: 409 },
    )
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
        .select("id, orden_id, producto_id, variante_id, cantidad, precio")
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

  if (destination === "customer_balance" && claimId === null) {
    const { data: balanceClaim } = await auth.admin
      .from("order_claims")
      .select("id")
      .eq("order_id", orderId)
      .in("resolution", ["cupon_descuento", "saldo_a_favor"])
      .not("status", "eq", "rechazado")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    claimId = balanceClaim?.id ? Number(balanceClaim.id) : null
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
      ? auth.admin.from("productos").select("id, nombre").in("id", productIds)
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
        typeof item.variante_id === "number"
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
    })
    .maybeSingle()

  if (reservationFailure || !reservedNote) {
    return NextResponse.json(
      { error: reservationError(reservationFailure?.message) },
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
  let arcaAuthorizationPersisted = false
  try {
    const pointOfSale = getPointOfSale()
    const lastNumber = await feCompUltimoAutorizado(
      pointOfSale,
      NOTA_CREDITO_C_TYPE,
    )
    const lastVoucher = await feCompConsultar(
      pointOfSale,
      lastNumber,
      NOTA_CREDITO_C_TYPE,
    )
    const issueDate = argentinaDate()
    validateIssueDateAfterLastAuthorized(issueDate.arca, lastVoucher?.voucherDate)

    const authorization = await fecaeSolicitar({
      pointOfSale,
      voucherType: NOTA_CREDITO_C_TYPE,
      voucherNumber: lastNumber + 1,
      voucherDate: issueDate.arca,
      total: totalAmount,
      associatedVoucher: {
        voucherType: FACTURA_C_TYPE,
        pointOfSale: Number(order.invoice_point),
        voucherNumber: Number(order.invoice_number),
        voucherDate: isoDateToArca(order.invoice_created_at),
      },
    })
    const authorizedAt = new Date().toISOString()
    const caeDue = arcaDateToIso(authorization.caeDueDate)

    const { data: note, error: noteUpdateError } = await auth.admin
      .from("order_credit_notes")
      .update({
        status: "authorized",
        voucher_point: pointOfSale,
        voucher_number: authorization.voucherNumber,
        cae: authorization.cae,
        cae_due: caeDue,
        authorized_at: authorizedAt,
        updated_at: authorizedAt,
        error: null,
        management_status:
          destination === "customer_balance"
            ? "nota_credito_emitida"
            : "reembolso_pendiente",
        settlement_status:
          destination === "customer_balance" ? "procesando" : "pendiente",
      })
      .eq("id", noteId)
      .eq("status", "processing")
      .select("*, order_credit_note_items(*)")
      .single()

    if (noteUpdateError || !note) {
      throw new Error(
        "ARCA autorizó la nota de crédito, pero no se pudo guardar el comprobante.",
      )
    }
    arcaAuthorizationPersisted = true

    if (
      stockDestination === "stock_vendible" &&
      ["producto_aprobado", "aprobado_parcial"].includes(receptionStatus)
    ) {
      const orderItemsById = new Map(
        items.map((item) => [Number(item.id), item]),
      )
      const returnMovements = (note.order_credit_note_items ?? [])
        .map((creditItem: {
          id: number
          order_item_id: number
          approved_quantity?: number | null
          quantity: number
        }) => {
          const orderItem = orderItemsById.get(Number(creditItem.order_item_id))
          const quantity = Number(
            creditItem.approved_quantity ?? creditItem.quantity ?? 0,
          )
          if (!orderItem || quantity <= 0) return null

          return {
            source_key: `credit-note-item:${creditItem.id}`,
            order_id: orderId,
            order_item_id: Number(orderItem.id),
            product_id: Number(orderItem.producto_id),
            variant_id:
              typeof orderItem.variante_id === "number"
                ? orderItem.variante_id
                : null,
            quantity,
            approved_by: auth.user.id,
            approved_at: authorizedAt,
          }
        })
        .filter(
          (
            movement: InventoryReturnMovement | null,
          ): movement is InventoryReturnMovement => Boolean(movement),
        )

      if (returnMovements.length) {
        const { error: stockMovementError } = await auth.admin
          .from("inventory_return_movements")
          .upsert(returnMovements, { onConflict: "source_key", ignoreDuplicates: true })

        if (stockMovementError) {
          throw new Error(
            "La nota fue autorizada, pero no se pudo registrar el reingreso de stock.",
          )
        }

        await auth.admin
          .from("order_credit_note_items")
          .update({ stock_processed_at: authorizedAt })
          .eq("credit_note_id", noteId)
          .gt("approved_quantity", 0)

        await auth.admin
          .from("order_credit_notes")
          .update({
            stock_reviewed_by: auth.user.id,
            stock_reviewed_at: authorizedAt,
          })
          .eq("id", noteId)
      }
    }

    const { data: authorizedNotes } = await auth.admin
      .from("order_credit_notes")
      .select("*, order_credit_note_items(*)")
      .eq("order_id", orderId)
      .eq("status", "authorized")
    const cumulativeAmount = roundCreditMoney(
      (authorizedNotes ?? []).reduce(
        (sum, current) => sum + Number(current.total_amount ?? 0),
        0,
      ),
    )
    const cumulativeBalanceAmount = roundCreditMoney(
      (authorizedNotes ?? [])
        .filter((current) => current.destination === "customer_balance")
        .reduce(
          (sum, current) => sum + Number(current.total_amount ?? 0),
          0,
        ),
    )
    const settlesCancellationToBalance =
      destination === "customer_balance" &&
      (
        order.estado === "cancelado" ||
        ["cancellation_requested", "refund_pending"].includes(
          order.financial_status ?? "",
        )
      )

    // La acreditación se ejecuta solamente después de persistir el CAE.
    // Es idempotente por punto y número de comprobante.
    const customerCreditMovement =
      destination === "customer_balance"
        ? await creditCustomerForOrderCreditNote(auth.admin, {
            userId: order.usuario_id,
            orderId,
            amount: totalAmount,
            creditNoteNumber: authorization.voucherNumber,
            creditNotePoint: pointOfSale,
            creditNoteCae: authorization.cae,
            claimId,
            createdBy: auth.user.id,
            metadata: {
              order_credit_note_id: noteId,
              associated_invoice_point: order.invoice_point,
              associated_invoice_number: order.invoice_number,
            },
          })
        : null

    if (destination === "customer_balance") {
      await auth.admin
        .from("order_credit_notes")
        .update({
          management_status: "finalizada",
          settlement_status: "completado",
          settlement_date: issueDate.iso,
          updated_at: authorizedAt,
        })
        .eq("id", noteId)
    }

    const legacyCreditNote = {
      credit_note_status: "authorized",
      credit_note_number: String(authorization.voucherNumber),
      credit_note_point: pointOfSale,
      credit_note_cae: authorization.cae,
      credit_note_cae_due: caeDue,
      credit_note_created_at: authorizedAt,
      credit_note_amount: cumulativeAmount,
      credit_note_error: null,
      credit_note_required: false,
      credit_note_issued: true,
      credit_note_issued_at: authorizedAt,
      ...(settlesCancellationToBalance
        ? {
            financial_status: "refunded",
            refund_amount: cumulativeBalanceAmount,
            refund_method: "Saldo en cuenta BEYONIX",
            refunded_at: authorizedAt,
            refunded_by: auth.user.id,
          }
        : {}),
    }
    const { data: updatedOrder, error: orderUpdateError } = await auth.admin
      .from("ordenes")
      .update(legacyCreditNote)
      .eq("id", orderId)
      .select()
      .single()
    if (orderUpdateError || !updatedOrder) {
      throw new Error(
        "La nota fue autorizada, pero no se pudo actualizar el resumen del pedido.",
      )
    }

    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action: "credit_note_authorized",
      previousStatus: order.credit_note_status ?? null,
      newStatus: "authorized",
      metadata: {
        orderCreditNoteId: noteId,
        amount: totalAmount,
        itemsAmount,
        manualAmount,
        destination,
        reason: storedReason,
        items: selectedItems,
        creditNoteNumber: authorization.voucherNumber,
        creditNotePoint: pointOfSale,
        associatedInvoicePoint: order.invoice_point,
        associatedInvoiceNumber: order.invoice_number,
        customerCreditMovementId:
          customerCreditMovement && "movement_id" in customerCreditMovement
            ? customerCreditMovement.movement_id
            : null,
      },
    })

    if (settlesCancellationToBalance) {
      await appendOrderAuditEvent(auth.admin, {
        orderId,
        actorType: "system",
        actorId: null,
        action: "order_refunded_to_customer_balance",
        previousStatus: order.financial_status ?? "refund_pending",
        newStatus: "refunded",
        metadata: {
          orderCreditNoteId: noteId,
          amount: totalAmount,
          cumulativeAmount: cumulativeBalanceAmount,
          customerCreditMovementId:
            customerCreditMovement && "movement_id" in customerCreditMovement
              ? customerCreditMovement.movement_id
              : null,
        },
      })
    }

    return NextResponse.json({
      order: { ...updatedOrder, order_credit_notes: authorizedNotes ?? [note] },
      note,
      credit_note: {
        voucher_type: NOTA_CREDITO_C_TYPE,
        credit_note_number: String(authorization.voucherNumber),
        credit_note_point: pointOfSale,
        credit_note_cae: authorization.cae,
        credit_note_cae_due: caeDue,
        issue_date: issueDate.iso,
        amount: totalAmount,
        associated_invoice: {
          voucher_type: FACTURA_C_TYPE,
          point: order.invoice_point,
          number: order.invoice_number,
        },
        qr_url: buildArcaQrUrl({
          issueDate: issueDate.iso,
          cuit: process.env.ARCA_CUIT ?? "",
          pointOfSale,
          voucherType: NOTA_CREDITO_C_TYPE,
          voucherNumber: authorization.voucherNumber,
          total: totalAmount,
          cae: authorization.cae,
        }),
        observations: authorization.observations,
      },
      customer_credit_movement: customerCreditMovement,
    })
  } catch (error) {
    const message = creditNoteErrorMessage(error)

    if (arcaAuthorizationPersisted) {
      await appendOrderAuditEvent(auth.admin, {
        orderId,
        actorType: "system",
        actorId: null,
        action: "credit_note_post_authorization_error",
        previousStatus: "authorized",
        newStatus: "authorized",
        metadata: { orderCreditNoteId: noteId, error: message },
      })
      console.error("Error posterior a la autorización de Nota de Crédito C", {
        orderId,
        noteId,
        error: message,
      })
      return NextResponse.json(
        {
          error:
            "ARCA autorizó la nota de crédito, pero falló una acción posterior. El comprobante fiscal sigue siendo válido; revisá el historial antes de reintentar.",
          note_authorized: true,
        },
        { status: 500 },
      )
    }

    await auth.admin
      .from("order_credit_notes")
      .update({ status: "error", error: message, updated_at: new Date().toISOString() })
      .eq("id", noteId)
      .eq("status", "processing")

    await auth.admin
      .from("ordenes")
      .update({ credit_note_status: "error", credit_note_error: message })
      .eq("id", orderId)

    console.error("Error al emitir Nota de Crédito C", { orderId, noteId, error: message })
    return NextResponse.json(
      { error: message },
      { status: error instanceof ArcaWsError ? 502 : 500 },
    )
  }
}
