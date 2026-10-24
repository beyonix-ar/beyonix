import type { SupabaseOrderAuditEvent, SupabasePedido } from "../supabase/types.ts"
import { formatCuentaOrderDate } from "./account-formatters.ts"
import { deriveOrderCancellationInfo } from "../orders/order-cancellation-origin.ts"
import { isOrderPaymentConfirmed } from "../orders/order-payment-status.ts"
import {
  getOrderCancellationRefundState,
  ORDER_CANCELLATION_REFUND_LABELS,
  type OrderCancellationRefundState,
} from "../orders/order-cancellation-refund-state.ts"
import { validatePassword } from "../validation/account-fields.ts"
import { isRandomColorName, RANDOM_VARIANT_LABEL } from "../products/color-mode.ts"
import {
  getShippingStage,
  SHIPPING_STAGE_LABELS,
  SHIPPING_STAGES,
  shippingStageIndex,
  type ShippingStage,
  type ShippingStageOrder,
} from "../orders/shipping-stage.ts"

export type OrderProgressTone = "done" | "current" | "pending" | "danger" | "warning"

export interface OrderProgressStep {
  label: string
  detail: string
  tone: OrderProgressTone
}

export type CustomerOrderDetailView = "detalle" | "factura" | "reclamo"

const SHIPPING_INCIDENT_LABELS: Record<string, string> = {
  visita_fallida: "Visita fallida",
  retiro_vencido: "Retiro vencido",
  en_devolucion: "En devolución",
  devuelto_beyonix: "Devuelto a BEYONIX",
}

export interface CustomerShippingMilestone {
  label: string
  detail: string
}

type CustomerShippingOrder = ShippingStageOrder &
  Partial<Pick<SupabasePedido, "shipping_provider" | "envio_proveedor" | "andreani_tracking" | "dispatch_progress">>

/** Etapa visible del envío (misma regla que Admin, ver lib/orders/shipping-stage). */
export function getCustomerShippingStage(order: CustomerShippingOrder, paymentConfirmed: boolean): ShippingStage | null {
  return getShippingStage(order, { paymentConfirmed, dispatchProgress: order.dispatch_progress })
}

const SHIPPING_INCIDENT_DETAIL = "El envío tiene una incidencia logística. BEYONIX está revisando el seguimiento."

/**
 * Hitos del envío tal como los ve el cliente: textos simples, nunca códigos,
 * eventos ni estados crudos de Andreani. "Despachado" llega con el QR final
 * del Bulto; "En camino", sólo con un movimiento real de Andreani.
 */
export function getCustomerShippingMilestone(
  order: CustomerShippingOrder,
  paymentConfirmed = false,
): CustomerShippingMilestone | null {
  const estado = (order.estado ?? "").toLowerCase()
  if (estado === "en_sucursal") return { label: "En sucursal", detail: "Tu pedido llegó a la sucursal. Ya podés retirarlo." }
  if (estado === "retiro_pendiente") return { label: "Listo para retirar", detail: "Tu pedido te espera en la sucursal." }
  if (SHIPPING_INCIDENT_LABELS[estado]) return { label: SHIPPING_INCIDENT_LABELS[estado], detail: SHIPPING_INCIDENT_DETAIL }

  const stage = getCustomerShippingStage(order, paymentConfirmed)
  switch (stage) {
    case "delivered":
      return { label: SHIPPING_STAGE_LABELS.delivered, detail: "Tu pedido fue entregado." }
    case "in_transit":
      return { label: SHIPPING_STAGE_LABELS.in_transit, detail: "Tu pedido está en camino." }
    case "dispatched": {
      const andreani = Boolean(order.andreani_tracking) ||
        [order.shipping_provider, order.envio_proveedor].some((provider) => (provider ?? "").toLowerCase() === "andreani")
      return {
        label: SHIPPING_STAGE_LABELS.dispatched,
        detail: andreani ? "Andreani recibió tu paquete." : "Tu pedido fue despachado.",
      }
    }
    case "ready":
      return { label: SHIPPING_STAGE_LABELS.ready, detail: "Tu pedido ya está preparado y listo para salir." }
    case "preparing":
      return { label: SHIPPING_STAGE_LABELS.preparing, detail: "Estamos preparando tu pedido." }
    default:
      return null
  }
}
const DISPATCHED_ORDER_STATUSES = [
  "enviado",
  "en_camino",
  "visita_fallida",
  "en_sucursal",
  "retiro_pendiente",
  "retiro_vencido",
  "en_devolucion",
  "devuelto_beyonix",
  "entregado",
]

export type DeliveryAddressDraft = {
  codigoPostal: string
  calle: string
  numero: string
  piso?: string
  departamento?: string
  localidad: string
  region: string
  pais: "Argentina"
  componentesDeDireccion: []
}

export function isInvoiceAvailable(order: Pick<SupabasePedido, "invoice_status">) {
  return order.invoice_status === "authorized"
}

/**
 * NC visible para el cliente: autorizada en ARCA sobre una factura autorizada
 * (el endpoint ?type=credit_note vuelve a exigir titularidad y ambas
 * autorizaciones). Compartida por el detalle y "Mis compras".
 */
export function isCustomerCreditNoteAvailable(
  order: Pick<SupabasePedido, "invoice_status" | "credit_note_status" | "credit_note_number" | "credit_note_point" | "credit_note_cae">,
) {
  return isInvoiceAvailable(order) &&
    order.credit_note_status === "authorized" &&
    Boolean(order.credit_note_number && order.credit_note_point && order.credit_note_cae)
}

export function isInvoiceGenerating(order: SupabasePedido) {
  return isOrderPaymentConfirmed(order) &&
    !isInvoiceAvailable(order) &&
    (order.invoice_status === "pending" || order.invoice_status === "processing")
}

export function isInvoiceAwaitingRetry(order: SupabasePedido) {
  return isOrderPaymentConfirmed(order) &&
    order.invoice_status === "error" &&
    !order.invoice_cae
}

type OrderStatusFields = Pick<
  SupabasePedido,
  "estado" | "payment_status" | "financial_status"
> & CustomerShippingOrder & {
  cancellation_requested_by?: string | null
  order_audit_events?: SupabaseOrderAuditEvent[] | null
}

/**
 * Rechazado (nunca hubo pago confirmado) vs cancelado (con pago
 * confirmado) se distingue con el mismo criterio que ya usa el admin en
 * buildOrderTimeline (order_audit_events), no con un estado nuevo -- ver
 * lib/orders/order-cancellation-origin.ts.
 */
export function getClientOrderStatusBadge(order: OrderStatusFields) {
  const status = order.estado.toLowerCase()
  const paymentStatus = order.payment_status ?? ""
  const financialStatus = order.financial_status ?? ""

  if (status === "cancelado") {
    const cancellationInfo = deriveOrderCancellationInfo(order.order_audit_events, {
      cancellation_requested_by: order.cancellation_requested_by,
    })

    if (cancellationInfo.rejectedByAdmin) {
      return {
        label: "Pedido rechazado",
        className: "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)]",
      }
    }

    return {
      label: "Pedido cancelado",
      className: "border-[var(--account-neutral-border)] bg-[var(--account-neutral-bg)] text-[var(--account-neutral-text)]",
    }
  }

  if (financialStatus === "refund_pending") {
    return {
      label: "Reintegro pendiente",
      className: "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning-text)]",
    }
  }

  if (financialStatus === "cancellation_requested") {
    return {
      label: "Cancelación en revisión",
      className: "border-[var(--account-info-border)] bg-[var(--account-info-bg)] text-[var(--account-info-text)]",
    }
  }

  if (financialStatus === "refunded") {
    return {
      label: "Dinero reintegrado",
      className: "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)]",
    }
  }

  if (paymentStatus === "vencido_falta_comprobante") {
    return {
      label: "Cancelado por falta de pago",
      className: "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)]",
    }
  }

  if (paymentStatus === "rechazado") {
    return {
      label: "Comprobante rechazado",
      className: "border-[var(--account-danger-border)] bg-[var(--account-danger-bg)] text-[var(--account-danger-text)]",
    }
  }

  if (SHIPPING_INCIDENT_LABELS[status]) {
    return {
      label: SHIPPING_INCIDENT_LABELS[status],
      className: "border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] text-[var(--account-warning-text)]",
    }
  }

  // Sin pago confirmado no hay etapas de preparación: sólo Despachado en adelante.
  const shippingStage = getCustomerShippingStage(order, false)
  if (shippingStage === "delivered") {
    return {
      label: SHIPPING_STAGE_LABELS.delivered,
      className: "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)]",
    }
  }

  if (shippingStage) {
    return {
      label: getCustomerShippingMilestone(order)?.label ?? SHIPPING_STAGE_LABELS[shippingStage],
      className: "border-[var(--account-info-border)] bg-[var(--account-info-bg)] text-[var(--account-info-text)]",
    }
  }

  if (
    paymentStatus === "confirmado" ||
    paymentStatus === "approved" ||
    status === "pagado"
  ) {
    return {
      label: "Pago confirmado",
      className: "border-[var(--account-success-border)] bg-[var(--account-success-bg)] text-[var(--account-success-text)]",
    }
  }

  return {
    label: "Pedido registrado",
    className:
      "border-[var(--account-neutral-border)] bg-[var(--account-neutral-bg)] text-[var(--account-neutral-text)]",
  }
}

export interface OrderPaymentTotalDisplay {
  label: string
  /** Borde + fondo del contenedor de la caja de total. */
  boxClassName: string
  /** Color de texto (label y monto) -- separado del borde/fondo para que cada
   * caja conserve su propio tamaño/tipografía sin duplicar la lógica de tono. */
  textClassName: string
}

/**
 * Única fuente de verdad de "¿decimos 'Total pagado'?" para historial y
 * detalle de compra (ver isOrderPaymentConfirmed -- la misma que ya usa
 * showPaymentProofSection en cuenta-client.tsx y el cancel de admin/cliente).
 * Nunca `estado`/`estado==='pagado'` solo: un intento de Mercado Pago
 * abandonado o rechazado queda en `estado='pendiente'` (reclamable, ver fix
 * de reintentos MP) sin que eso implique que se cobró algo.
 */
export function getOrderPaymentTotalDisplay(
  order: Parameters<typeof isOrderPaymentConfirmed>[0],
): OrderPaymentTotalDisplay {
  if (isOrderPaymentConfirmed(order)) {
    return {
      label: "Total pagado",
      boxClassName: "border-[var(--account-success-border)] bg-[var(--account-success-bg)]",
      textClassName: "text-[var(--account-success-text)]",
    }
  }

  return {
    label: "Total del pedido",
    boxClassName: "border-[var(--account-neutral-border)] bg-[var(--account-neutral-bg)]",
    textClassName: "text-[var(--account-neutral-text)]",
  }
}

export function getCuentaItemColor(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  const itemColor = item as typeof item & {
    color?: string | null
    color_nombre?: string | null
  }

  const color = (
    item.conditioned_name ||
    item.producto_variantes?.nombre ||
    itemColor.color_nombre ||
    itemColor.color ||
    "Sin color"
  )
  return isRandomColorName(color) ? RANDOM_VARIANT_LABEL : color
}

type CuentaItemImageFields = {
  conditioned_images?: string[] | null
  producto_variantes?: { imagenes?: string[] | null } | null
  productos?: {
    imagen_principal?: string | null
    imagenes_producto?: { url: string }[] | null
  } | null
}

export function getCuentaItemImage(item: CuentaItemImageFields) {
  return (
    item.conditioned_images?.[0] ||
    item.producto_variantes?.imagenes?.[0] ||
    item.productos?.imagen_principal ||
    item.productos?.imagenes_producto?.[0]?.url ||
    ""
  )
}

type PaymentProgressFields = Pick<
  SupabasePedido,
  | "payment_status"
  | "financial_status"
  | "estado"
  | "payment_method_id"
  | "payment_proof_url"
  | "payment_proof_uploaded_at"
  | "paid_at"
>

export function getPaymentProgressLabel(order: PaymentProgressFields) {
  const paymentStatus = order.payment_status ?? ""
  const financialStatus = order.financial_status ?? ""

  // Transferencia real recibida con el pedido ya cancelado: no se aplicó a
  // ninguna compra y la revisa el equipo (nunca "cancelado" a secas).
  if (paymentStatus === "approved_after_cancellation") {
    return "Pago recibido tras cancelar (en revisión)"
  }

  if (paymentStatus === "vencido_falta_comprobante") {
    return "Cancelado por falta de pago"
  }

  // Pedido cancelado: estado final (misma fuente de verdad que Admin). Nunca
  // vuelve a "Esperando confirmación del pago".
  const cancellationState = getOrderCancellationRefundState(order)
  if (cancellationState) {
    return ORDER_CANCELLATION_REFUND_LABELS[cancellationState].customer
  }

  if (financialStatus === "refund_pending") {
    return "Reintegro pendiente"
  }

  if (financialStatus === "cancellation_requested") {
    return "Cancelación en revisión"
  }

  if (financialStatus === "refunded") {
    return "Dinero reintegrado"
  }

  if (order.payment_method_id === "customer_credit") {
    return "Pagado con saldo a favor"
  }

  if (order.payment_method_id !== "transferencia") {
    if (paymentStatus === "approved" || order.estado === "pagado") {
      return "Pago aprobado"
    }

    return "Esperando confirmación del pago"
  }

  if (paymentStatus === "confirmado" || order.estado === "pagado") {
    return "Transferencia confirmada"
  }

  if (
    paymentStatus === "en_revision" ||
    Boolean(order.payment_proof_url || order.payment_proof_uploaded_at)
  ) {
    return "Comprobante recibido"
  }

  if (paymentStatus === "rechazado") {
    return "Comprobante rechazado"
  }

  // El vencimiento de la reserva lo muestra TransferReservationNotice.
  return "Pago pendiente"
}

/** Texto de cada paso de envío según si ya pasó, es el actual o falta. */
const SHIPPING_STEP_DETAILS: Record<ShippingStage, { reached: string; pending: string }> = {
  preparing: { reached: "Estamos preparando tu pedido.", pending: "Este paso empieza cuando se confirme el pago." },
  ready: { reached: "Tu pedido ya está preparado y listo para salir.", pending: "Se completa cuando terminemos de preparar tu pedido." },
  dispatched: { reached: "Tu pedido fue despachado.", pending: "Se completa cuando entreguemos tu paquete al transporte." },
  in_transit: { reached: "Tu pedido está en camino.", pending: "Este paso se activa cuando Andreani inicia el transporte." },
  delivered: { reached: "Tu pedido fue entregado.", pending: "Último paso del recorrido." },
}

function getShippingProgressSteps(order: SupabasePedido, isPaid: boolean): OrderProgressStep[] {
  const estado = order.estado.toLowerCase()
  const stage = getCustomerShippingStage(order, isPaid)
  const reachedIndex = shippingStageIndex(stage)
  const milestone = getCustomerShippingMilestone(order, isPaid)
  const hasShippingIncident = Boolean(SHIPPING_INCIDENT_LABELS[estado])
  const isAtBranch = estado === "en_sucursal" || estado === "retiro_pendiente"

  return SHIPPING_STAGES.map((step, index) => {
    const reached = index <= reachedIndex
    const isCurrent = index === reachedIndex
    let label = SHIPPING_STAGE_LABELS[step]
    let detail = reached ? SHIPPING_STEP_DETAILS[step].reached : SHIPPING_STEP_DETAILS[step].pending
    if (isCurrent && milestone) detail = milestone.detail
    if (step === "in_transit") {
      if (isAtBranch && milestone) label = milestone.label
      if (hasShippingIncident) detail = SHIPPING_INCIDENT_DETAIL
      else if (stage === "delivered") detail = "El envío completó su recorrido."
    }
    const tone: OrderProgressTone = !reached ? "pending" : isCurrent && step !== "delivered" ? "current" : "done"
    return { label, detail, tone }
  })
}

export function getOrderProgressSteps(order: SupabasePedido): OrderProgressStep[] {
  const estado = order.estado.toLowerCase()
  const paymentStatus = order.payment_status ?? ""
  const financialStatus = order.financial_status ?? ""
  const refundPending = financialStatus === "refund_pending"
  const refunded = financialStatus === "refunded"
  const isRejected = paymentStatus === "rechazado"
  const isPaid =
    estado === "pagado" ||
    DISPATCHED_ORDER_STATUSES.includes(estado) ||
    paymentStatus === "confirmado" ||
    paymentStatus === "approved"

  const cancellationState = getOrderCancellationRefundState(order)
  if (cancellationState) {
    return getCancelledOrderProgressSteps(order, cancellationState)
  }

  if (refundPending || refunded) {
    return [
      {
        label: "Pedido registrado",
        detail: formatCuentaOrderDate(order.created_at),
        tone: "done",
      },
      {
        label: "Pago confirmado",
        detail: order.payment_confirmed_at
          ? formatCuentaOrderDate(order.payment_confirmed_at)
          : "El pago fue confirmado.",
        tone: "done",
      },
      {
        label: "Cancelación solicitada",
        detail: order.cancellation_requested_at
          ? formatCuentaOrderDate(order.cancellation_requested_at)
          : "Recibimos tu solicitud.",
        tone: "done",
      },
      {
        label: refunded ? "Dinero reintegrado" : "Reintegro pendiente",
        detail: refunded
          ? order.refunded_at
            ? formatCuentaOrderDate(order.refunded_at)
            : "El reintegro fue registrado."
          : "BEYONIX está gestionando la devolución.",
        tone: refunded ? "done" : "warning",
      },
    ]
  }

  if (isRejected) {
    return [
      {
        label: "Pedido registrado",
        detail: formatCuentaOrderDate(order.created_at),
        tone: "done",
      },
      {
        label: "Comprobante rechazado",
        detail: "Podés subir un nuevo comprobante.",
        tone: "danger",
      },
    ]
  }

  return [
    {
      label: "Pedido registrado",
      detail: formatCuentaOrderDate(order.created_at),
      tone: "done",
    },
    {
      label: getPaymentProgressLabel(order),
      detail: isPaid
        ? "El pago ya fue confirmado."
        : "Te avisaremos cuando se haya aprobado.",
      tone: isPaid ? "done" : "warning",
    },
    ...getShippingProgressSteps(order, isPaid),
  ]
}

/**
 * Timeline final de un pedido cancelado: termina en la cancelación (y el
 * reintegro si hubo cobro). Los pasos de envío no aplican y no se muestran
 * como pendientes.
 */
function getCancelledOrderProgressSteps(
  order: SupabasePedido,
  state: OrderCancellationRefundState,
): OrderProgressStep[] {
  const rejectedByAdmin = deriveOrderCancellationInfo(order.order_audit_events, {
    cancellation_requested_by: order.cancellation_requested_by,
  }).rejectedByAdmin
  const cancelledAt = order.cancelled_at || order.cancellation_requested_at
  const steps: OrderProgressStep[] = [
    { label: "Pedido registrado", detail: formatCuentaOrderDate(order.created_at), tone: "done" },
  ]
  // Un pago recibido después de cancelar no fue un paso previo de la compra.
  if (state !== "cancelled" && order.payment_status !== "approved_after_cancellation") {
    steps.push({
      label: "Pago confirmado",
      detail: order.paid_at ? formatCuentaOrderDate(order.paid_at) : "El pago fue confirmado.",
      tone: "done",
    })
  }
  steps.push({
    label: rejectedByAdmin ? "Pedido rechazado" : "Pedido cancelado",
    detail: cancelledAt ? formatCuentaOrderDate(cancelledAt) : "La compra fue cancelada.",
    tone: rejectedByAdmin ? "danger" : "done",
  })
  if (state === "refund_in_progress") {
    steps.push({ label: "Reintegro en proceso", detail: "BEYONIX está gestionando la devolución.", tone: "warning" })
  } else if (state === "refund_rejected") {
    steps.push({ label: "Devolución revisada", detail: CUSTOMER_REFUND_REJECTED_DETAIL, tone: "warning" })
  } else if (state === "refunded") {
    steps.push({
      label: "Reintegro realizado",
      detail: order.refunded_at ? formatCuentaOrderDate(order.refunded_at) : "El reintegro fue registrado.",
      tone: "done",
    })
  }
  return steps
}

/** Texto único para el cliente cuando la devolución no se aprobó (sin detalles internos). */
export const CUSTOMER_REFUND_REJECTED_DETAIL = "Revisamos la devolución y no pudimos aprobar el reintegro."

export interface CustomerRefundSummary {
  state: Exclude<OrderCancellationRefundState, "cancelled" | "refund_rejected">
  statusLabel: "En proceso" | "Realizado"
  /** Importe devuelto (o a devolver); null si el pedido no lo informa. */
  amount: number | null
  /** Medio del reintegro tal como quedó registrado; null si todavía no se definió. */
  methodLabel: string | null
  requestedAt: string | null
  completedAt: string | null
}

function getRefundMethodLabel(refundMethod: string | null | undefined) {
  const method = (refundMethod ?? "").trim()
  if (!method) return null
  const normalized = method.toLowerCase()
  if (normalized.includes("mercado")) return "Mercado Pago"
  if (normalized.includes("saldo")) return "Saldo BEYONIX"
  if (normalized.includes("transfer") || normalized.includes("manual")) return "Transferencia bancaria"
  return method
}

/**
 * Datos del reintegro visibles para el cliente (sólo columnas del DTO del
 * cliente; nunca identificadores internos de Mercado Pago). null si el
 * pedido no tiene un reintegro (cancelado sin cobro o no cancelado).
 */
export function getCustomerRefundSummary(order: SupabasePedido): CustomerRefundSummary | null {
  const state = getOrderCancellationRefundState(order)
  if (state !== "refund_in_progress" && state !== "refunded") return null
  const amount = order.refund_amount ?? order.external_amount_due
  return {
    state,
    statusLabel: state === "refunded" ? "Realizado" : "En proceso",
    amount: amount === null || amount === undefined ? null : Number(amount),
    methodLabel: getRefundMethodLabel(order.refund_method),
    requestedAt: order.refund_pending_at || order.cancellation_requested_at || order.cancelled_at || null,
    completedAt: state === "refunded" ? order.refunded_at ?? null : null,
  }
}

export function normalizeTrackingUrl(value?: string | null) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export function splitLegacyAddress(value: string) {
  const cleanValue = value.trim()
  const match = cleanValue.match(/^(.*?)(\d+[a-zA-Z]?)\b(.*)$/)

  if (!match) {
    return {
      street: cleanValue,
      number: "",
    }
  }

  return {
    street: match[1].replace(/[,\s]+$/, "").trim(),
    number: match[2].trim(),
  }
}

export function parseProfileAddress(
  value: string,
  province?: string,
  postalCode?: string,
) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const baseAddress = splitLegacyAddress(parts[0] ?? value)
  let floor = ""
  let apartment = ""
  let locality = ""

  for (const part of parts.slice(1)) {
    if (/^piso\s+/i.test(part)) {
      floor = part.replace(/^piso\s+/i, "").trim()
      continue
    }

    if (/^depto\s+/i.test(part)) {
      apartment = part.replace(/^depto\s+/i, "").trim()
      continue
    }

    if (province && part.toLowerCase() === province.toLowerCase()) {
      continue
    }

    if (postalCode && part.toLowerCase() === `cp ${postalCode}`.toLowerCase()) {
      continue
    }

    if (!locality) {
      locality = part
    }
  }

  return {
    ...baseAddress,
    floor,
    apartment,
    locality,
  }
}

export function buildDeliveryAddressDraft({
  postalCode,
  street,
  streetNumber,
  floor,
  apartment,
  locality,
  province,
}: {
  postalCode: string
  street: string
  streetNumber: string
  floor: string
  apartment: string
  locality: string
  province: string
}): DeliveryAddressDraft {
  return {
    codigoPostal: postalCode.trim(),
    calle: street.trim(),
    numero: streetNumber.trim(),
    piso: floor.trim() || undefined,
    departamento: apartment.trim().toLocaleUpperCase("es-AR") || undefined,
    localidad: locality.trim(),
    region: province.trim(),
    pais: "Argentina",
    componentesDeDireccion: [],
  }
}

export function formatDeliveryAddressForProfile(address: DeliveryAddressDraft) {
  const optionalParts = [
    address.piso ? `Piso ${address.piso}` : "",
    address.departamento ? `Depto ${address.departamento.toLocaleUpperCase("es-AR")}` : "",
  ].filter(Boolean)

  return [
    `${address.calle} ${address.numero}`,
    ...optionalParts,
    address.localidad,
    address.region,
    `CP ${address.codigoPostal}`,
  ].join(", ")
}

export function validateDeliveryAddress(address: DeliveryAddressDraft) {
  if (!address.calle) return "Introduce la calle."
  if (!address.numero) return "Introduce el número de calle."
  if (!/^\d{4,8}$/.test(address.codigoPostal)) {
    return "El código postal debe tener entre 4 y 8 números."
  }
  if (!address.localidad) return "Introduce la localidad."
  if (!address.region) return "Seleccioná una provincia válida."

  const commonPattern = /^[\p{L}\p{M}0-9\s.,'°/-]+$/u
  const values = [
    address.calle,
    address.numero,
    address.piso ?? "",
    address.departamento ?? "",
    address.localidad,
  ].filter(Boolean)

  if (values.some((value) => !commonPattern.test(value))) {
    return "La dirección contiene caracteres no permitidos."
  }

  return ""
}

export function validateAccountPassword(password: string) {
  return validatePassword(password)
}

export function uppercaseAccountText(value: string) {
  return value.toLocaleUpperCase("es-AR")
}

export function nonEmptyAccountText(value: string | undefined) {
  const trimmed = value?.trim()

  return trimmed ? trimmed : undefined
}
