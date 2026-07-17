import type { SupabasePedido } from "@/lib/supabase/types"
import { formatCuentaOrderDate } from "@/lib/account/account-formatters"
import { validatePassword } from "@/lib/validation/account-fields"

export type OrderProgressTone = "done" | "current" | "pending" | "danger" | "warning"

export interface OrderProgressStep {
  label: string
  detail: string
  tone: OrderProgressTone
}

export type CustomerOrderDetailView = "detalle" | "factura" | "reclamo"

const SHIPPING_INCIDENT_LABELS: Record<string, string> = {
  visita_fallida: "Visita fallida",
  en_sucursal: "En sucursal",
  retiro_pendiente: "Retiro pendiente",
  retiro_vencido: "Retiro vencido",
  en_devolucion: "En devolución",
  devuelto_beyonix: "Devuelto a BEYONIX",
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

export function isInvoiceAvailable(order: SupabasePedido) {
  return order.invoice_status === "authorized"
}

export function getClientOrderStatusBadge(order: SupabasePedido) {
  const status = order.estado.toLowerCase()
  const paymentStatus = order.payment_status ?? ""
  const financialStatus = order.financial_status ?? ""

  if (status === "cancelado") {
    return {
      label: "Cancelado",
      className: "border-zinc-500/30 bg-zinc-500/12 text-zinc-200",
    }
  }

  if (financialStatus === "refund_pending") {
    return {
      label: "Reintegro pendiente",
      className: "border-amber-300/35 bg-amber-400/12 text-amber-200",
    }
  }

  if (financialStatus === "cancellation_requested") {
    return {
      label: "Cancelación en revisión",
      className: "border-beyonix-blue-light/35 bg-beyonix-blue/35 text-beyonix-sky",
    }
  }

  if (financialStatus === "refunded") {
    return {
      label: "Dinero reintegrado",
      className: "border-emerald-400/35 bg-emerald-400/12 text-emerald-200",
    }
  }

  if (paymentStatus === "vencido_falta_comprobante") {
    return {
      label: "Cancelado por falta de pago",
      className: "border-red-400/35 bg-red-400/12 text-red-200",
    }
  }

  if (paymentStatus === "rechazado") {
    return {
      label: "Comprobante rechazado",
      className: "border-red-400/35 bg-red-400/12 text-red-200",
    }
  }

  if (
    (paymentStatus === "confirmado" ||
      paymentStatus === "approved" ||
      status === "pagado") &&
    !DISPATCHED_ORDER_STATUSES.includes(status)
  ) {
    return {
      label: "Pago confirmado",
      className: "border-emerald-400/35 bg-emerald-400/12 text-emerald-200",
    }
  }

  if (status === "enviado" || status === "en_camino") {
    return {
      label: "En camino",
      className: "border-beyonix-blue-light/35 bg-beyonix-blue/35 text-beyonix-sky",
    }
  }

  if (SHIPPING_INCIDENT_LABELS[status]) {
    return {
      label: SHIPPING_INCIDENT_LABELS[status],
      className: "border-amber-300/35 bg-amber-400/12 text-amber-100",
    }
  }

  if (status === "entregado") {
    return {
      label: "Entregado",
      className: "border-emerald-400/35 bg-emerald-400/12 text-emerald-200",
    }
  }

  return {
    label: "Pedido registrado",
    className: "border-amber-300/35 bg-amber-400/12 text-amber-200",
  }
}

export function getCuentaItemColor(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  const itemColor = item as typeof item & {
    color?: string | null
    color_nombre?: string | null
  }

  return (
    item.producto_variantes?.nombre ||
    itemColor.color_nombre ||
    itemColor.color ||
    "Sin color"
  )
}

export function getCuentaItemImage(item: NonNullable<SupabasePedido["orden_items"]>[number]) {
  return (
    item.producto_variantes?.imagenes?.[0] ||
    item.productos?.imagen_principal ||
    item.productos?.imagenes_producto?.[0]?.url ||
    ""
  )
}

export function getPaymentProgressLabel(order: SupabasePedido) {
  const paymentStatus = order.payment_status ?? ""
  const financialStatus = order.financial_status ?? ""

  if (financialStatus === "refund_pending") {
    return "Reintegro pendiente"
  }

  if (financialStatus === "cancellation_requested") {
    return "Cancelación en revisión"
  }

  if (financialStatus === "refunded") {
    return "Dinero reintegrado"
  }

  if (paymentStatus === "vencido_falta_comprobante") {
    return "Cancelado por falta de pago"
  }

  if ((order.estado ?? "").toLowerCase() === "cancelado") {
    return "Pedido cancelado"
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

  return "Comprobante pendiente"
}

export function isAndreaniOrderInTransit(order: SupabasePedido) {
  const andreaniStatus = (order.andreani_estado ?? "").toLowerCase()

  return [
    "camino",
    "tránsito",
    "transito",
    "distribución",
    "distribucion",
    "reparto",
    "visita",
  ].some((status) => andreaniStatus.includes(status))
}

export function getOrderProgressSteps(order: SupabasePedido): OrderProgressStep[] {
  const estado = order.estado.toLowerCase()
  const paymentStatus = order.payment_status ?? ""
  const financialStatus = order.financial_status ?? ""
  const isCanceled = estado === "cancelado"
  const refundPending = financialStatus === "refund_pending"
  const refunded = financialStatus === "refunded"
  const isRejected = paymentStatus === "rechazado"
  const isPaid =
    estado === "pagado" ||
    DISPATCHED_ORDER_STATUSES.includes(estado) ||
    paymentStatus === "confirmado" ||
    paymentStatus === "approved"
  const isDispatched =
    DISPATCHED_ORDER_STATUSES.includes(estado) ||
    Boolean(order.tracking_number || order.andreani_tracking)
  const isDelivered = estado === "entregado"
  const hasShippingIncident = Boolean(SHIPPING_INCIDENT_LABELS[estado])
  const isInTransit = estado === "en_camino" || hasShippingIncident || isDelivered || isAndreaniOrderInTransit(order)

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

  if (isCanceled) {
    return [
      {
        label: "Pedido registrado",
        detail: formatCuentaOrderDate(order.created_at),
        tone: "done",
      },
      {
        label: "Pedido cancelado",
        detail: "La compra fue cancelada.",
        tone: "pending",
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
    {
      label: "Preparando envío",
      detail: isPaid
        ? "Estamos preparando tu pedido."
        : "Este paso empieza cuando se confirme el pago.",
      tone: isPaid ? (isDispatched ? "done" : "current") : "pending",
    },
    {
      label: "En camino",
      detail: hasShippingIncident
        ? "El envío tiene una incidencia logística. BEYONIX está revisando el seguimiento."
        : isInTransit
        ? "Andreani está llevando el pedido al domicilio indicado."
        : isDispatched
          ? "El envío fue generado y quedará activo cuando Andreani inicie el transporte."
          : "Este paso se activa cuando Andreani inicia el transporte.",
      tone: isInTransit ? (isDelivered ? "done" : "current") : "pending",
    },
    {
      label: "Entregado",
      detail: isDelivered
        ? "El pedido figura como entregado."
        : "Último paso del recorrido.",
      tone: isDelivered ? "done" : "pending",
    },
  ]
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
    departamento: apartment.trim() || undefined,
    localidad: locality.trim(),
    region: province.trim(),
    pais: "Argentina",
    componentesDeDireccion: [],
  }
}

export function formatDeliveryAddressForProfile(address: DeliveryAddressDraft) {
  const optionalParts = [
    address.piso ? `Piso ${address.piso}` : "",
    address.departamento ? `Depto ${address.departamento}` : "",
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
