/**
 * Contrato compartido (cliente/servidor) de los eventos de Analítica. Hoy
 * sólo existe `product_view`; los próximos eventos se suman acá y al CHECK
 * de `analytics_events.event_type`.
 */

export const PRODUCT_VIEW_SOURCES = ["product_page", "quick_view"] as const
export type ProductViewSource = (typeof PRODUCT_VIEW_SOURCES)[number]

export const PRODUCT_VIEW_ENDPOINT = "/api/analytics/product-view"

/**
 * Política de vista única: una misma sesión cuenta como máximo una vista por
 * producto cada 30 minutos. Debe coincidir con `v_dedup_window` de
 * `record_product_view` (la base es la fuente de verdad; el cliente sólo
 * evita requests que el servidor descartaría igual).
 */
export const PRODUCT_VIEW_DEDUP_WINDOW_MS = 30 * 60_000

/** Una sesión anónima termina tras 30 minutos sin actividad. */
export const ANALYTICS_SESSION_IDLE_MS = 30 * 60_000
