import { canChangeOrderStatus } from "./order-status-authorization.ts"

/**
 * Compara dos fechas ISO a nivel de día calendario (UTC), no de timestamp
 * exacto. La UI de edición de garantía solo captura fecha (YYYY-MM-DD), así
 * que reenviar la misma fecha sin tocarla puede perder el componente de
 * hora original; comparar por día evita marcar eso como "cambio real".
 */
export function isSameCalendarDay(
  a: string | null,
  b: string | null,
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false

  return (
    new Date(a).toISOString().slice(0, 10) ===
    new Date(b).toISOString().slice(0, 10)
  )
}

/**
 * Establecer `ordenes.delivered_at` equivale semánticamente a forzar el
 * pedido a "entregado": es la evidencia que usan garantías, reclamos,
 * cancelaciones y la UI para tratar el pedido como entregado. Por eso
 * respeta exactamente la misma política que /status para ese estado.
 */
export function canChangeDeliveredAt(
  role: string,
  previousDeliveredAt: string | null,
  nextDeliveredAt: string | null,
): boolean {
  if (isSameCalendarDay(previousDeliveredAt, nextDeliveredAt)) return true

  return canChangeOrderStatus(role, "entregado")
}
