import type { ArcaConfigurationStatus } from "./configuration.ts"

export interface ArcaAutoInvoicingControl {
  enabled: boolean
  cutoff_at: string | null
  updated_at: string
}

export interface ArcaAutoInvoicingView {
  enabled: boolean
  controlEnabled: boolean
  canActivate: boolean
  cutoffAt: string | null
  serverEnabled: boolean
}

export interface ArcaAutoInvoicingOrder {
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | string | null
  invoice_next_attempt_at?: string | null
  invoice_queued_at?: string | null
  invoice_arca_environment?: string | null
}

/**
 * ¿El worker automático va a emitir esta factura? Mismo filtro con el que el
 * worker toma pedidos de la cola (20261003120000): automático activo, en la
 * cola (pending/error con próximo intento), encolada después del corte, sin
 * número pedido ni CAE y fuera de homologación.
 */
export function isOrderInAutoInvoicingQueue(view: ArcaAutoInvoicingView, order: ArcaAutoInvoicingOrder) {
  if (!view.enabled || !view.cutoffAt) return false
  if (!["pending", "error"].includes(order.invoice_status ?? "") || !order.invoice_next_attempt_at) return false
  if (order.invoice_cae || order.invoice_number != null || order.invoice_arca_environment === "homologation") return false
  const queuedAt = new Date(order.invoice_queued_at ?? "").getTime()
  return Number.isFinite(queuedAt) && queuedAt > new Date(view.cutoffAt).getTime()
}

export function arcaAutoInvoicingView(
  control: ArcaAutoInvoicingControl,
  configuration: ArcaConfigurationStatus,
): ArcaAutoInvoicingView {
  const canActivate =
    configuration.configured &&
    configuration.environment === "production" &&
    configuration.autoInvoicingEnabled

  return {
    enabled: canActivate && control.enabled && Boolean(control.cutoff_at),
    controlEnabled: control.enabled,
    canActivate,
    cutoffAt: control.cutoff_at,
    serverEnabled: configuration.autoInvoicingEnabled,
  }
}
