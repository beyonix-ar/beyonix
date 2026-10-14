import type { ArcaInvoiceResult } from "../arca/invoice-automation.ts"

/**
 * Secuencia fiscal de una cancelación con pago: Factura C → NC C → reintegro.
 * La obligación de facturar nace con el pago válido confirmado (la base la
 * registra en invoice_queued_at, ver 20261014100000) y una cancelación
 * posterior no la borra: antes de mover dinero o emitir la NC, la venta tiene
 * que tener su Factura C.
 */
export interface InvoiceObligationOrder {
  invoice_queued_at?: string | null
  invoice_status?: string | null
  invoice_cae?: string | null
  total?: number | string | null
}

export function hasPendingInvoiceObligation(order: InvoiceObligationOrder) {
  return (
    Boolean(order.invoice_queued_at) &&
    !order.invoice_cae &&
    order.invoice_status !== "authorized" &&
    Number(order.total ?? 0) > 0
  )
}

export type SaleInvoicedResult = { ok: true } | { ok: false; error: string }

const BUSY_ATTEMPTS = 3
const BUSY_WAIT_MS = 1_500

/**
 * Emite (o confirma) la Factura C con el servicio único de ARCA, que ya es
 * idempotente: un pedido facturado devuelve already_authorized y un CAE
 * pedido sin confirmar se reconcilia antes de pedir otro número. Si otra
 * emisión tiene el turno (numeración serializada), se espera brevemente.
 */
export async function ensureSaleInvoiced(
  issueInvoice: () => Promise<ArcaInvoiceResult>,
  { attempts = BUSY_ATTEMPTS, waitMs = BUSY_WAIT_MS }: { attempts?: number; waitMs?: number } = {},
): Promise<SaleInvoicedResult> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await issueInvoice()
    switch (result.status) {
      case "authorized":
      case "already_authorized":
        return { ok: true }
      case "busy":
      case "idle":
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, waitMs))
        break
      case "not_invoiceable":
        return { ok: false, error: "La venta todavía no se puede facturar (cambio de pedido en curso). Reintentá cuando termine." }
      case "failed":
        return { ok: false, error: `La Factura C de esta venta está pendiente: ${result.error}` }
    }
  }
  return { ok: false, error: "La Factura C de esta venta se está emitiendo. Reintentá en unos segundos." }
}
