/**
 * Andreani no documenta un parámetro oficial para precargar un número de
 * tracking en su página pública de seguimiento (auditado 2026-08-25: la
 * página devuelve 403 a fetch automatizado y no hay evidencia en el
 * proyecto de una URL profunda estable). Por eso se abre siempre esta
 * página y se muestra el número aparte para copiar, en vez de inventar un
 * query param no confirmado.
 */
export const ANDREANI_PUBLIC_TRACKING_PAGE_URL =
  "https://www.andreani.com/?tab=seguir-envio"

interface OrderTrackingSource {
  andreani_tracking?: string | null
  tracking_number?: string | null
  tracking_url?: string | null
}

export interface ResolvedOrderTracking {
  /** Número a mostrar/copiar; null si el pedido todavía no tiene ninguno. */
  trackingNumber: string | null
  /** URL de seguimiento a abrir; null si no hay ninguna disponible. */
  url: string | null
  /** true si el seguimiento corresponde a un envío creado vía Andreani. */
  isAndreani: boolean
}

function normalizeUrl(value?: string | null) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Resuelve el tracking a mostrar/abrir para un pedido, sea el envío
 * creado por BEYONIX vía Andreani o cargado manualmente para un
 * transportista distinto. Cada pedido usa su propio
 * `andreani_tracking`/`tracking_number`; nunca un valor fijo.
 */
export function resolveOrderTrackingLink(
  order: OrderTrackingSource,
): ResolvedOrderTracking {
  const andreaniTracking =
    typeof order.andreani_tracking === "string" ? order.andreani_tracking.trim() : ""

  if (andreaniTracking) {
    return {
      trackingNumber: andreaniTracking,
      url: ANDREANI_PUBLIC_TRACKING_PAGE_URL,
      isAndreani: true,
    }
  }

  const manualTrackingNumber =
    typeof order.tracking_number === "string" ? order.tracking_number.trim() : ""
  const manualUrl = normalizeUrl(order.tracking_url)

  return {
    trackingNumber: manualTrackingNumber || null,
    url: manualUrl,
    isAndreani: false,
  }
}
