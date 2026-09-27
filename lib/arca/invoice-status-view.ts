/**
 * Estado FISCAL visible para Admin de una venta pagada sin CAE todavía.
 * Nunca se mezcla con el estado de pago: "Pago confirmado / Facturación
 * pendiente" es un estado válido y el pedido sigue su curso.
 */

export interface InvoiceFiscalStatusOrder {
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_error?: string | null
  invoice_next_attempt_at?: string | null
  invoice_requested_number?: number | string | null
}

export type InvoiceFiscalState = "pending" | "processing" | "error" | "not_queued"

export interface InvoiceFiscalStatusView {
  state: InvoiceFiscalState
  title: string
  description: string
  detail: string | null
}

function formatRetry(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  )
  return `${parts.day}/${parts.month} a las ${parts.hour}:${parts.minute}`
}

export function getInvoiceFiscalStatusView(
  order: InvoiceFiscalStatusOrder,
): InvoiceFiscalStatusView | null {
  if (order.invoice_cae || order.invoice_status === "authorized") return null

  if (order.invoice_status === "processing") {
    return {
      state: "processing",
      title: "Facturando…",
      description: "ARCA está procesando la Factura C. No hace falta emitir otra.",
      detail: null,
    }
  }

  if (order.invoice_status === "error") {
    const retry = formatRetry(order.invoice_next_attempt_at)
    const reconciling = order.invoice_requested_number != null
    return {
      state: "error",
      title: "Pago confirmado · Facturación con error",
      description: [
        retry
          ? `Se reintenta automáticamente desde el ${retry}.`
          : "No se reintenta automáticamente: requiere revisión.",
        reconciling
          ? "Hay un pedido de CAE sin confirmar: el próximo intento verifica en ARCA antes de pedir otro número."
          : null,
      ].filter(Boolean).join(" "),
      detail: order.invoice_error?.trim() || null,
    }
  }

  if (order.invoice_status === "pending") {
    return {
      state: "pending",
      title: "Pago confirmado · Facturación pendiente",
      description: "La Factura C se emite automáticamente. También podés emitirla ahora.",
      detail: null,
    }
  }

  return {
    state: "not_queued",
    title: "Pago confirmado · Facturación pendiente",
    description: "Esta venta no entró en la facturación automática: emitila desde acá.",
    detail: null,
  }
}
