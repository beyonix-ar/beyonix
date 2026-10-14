import { argentinaDateKey, isSameArgentinaDay } from "../business/dashboard-timezone.ts"
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

  // Día calendario de Argentina: una entrega a las 22 h AR ya es el día
  // siguiente en UTC y no debe contarse como un cambio de fecha.
  return isSameArgentinaDay(a, b)
}

/**
 * Fecha de un formulario (AAAA-MM-DD) como instante en hora argentina. Antes
 * se tomaba como medianoche UTC, que en Argentina es las 21 h del DÍA
 * ANTERIOR: la entrega y la garantía quedaban corridas un día.
 * `endOfDay` se usa para "válida hasta": cubre todo ese día argentino.
 */
export function parseArgentinaDateInput(value: unknown, endOfDay = false): string | null | undefined {
  if (value === null || value === "") return null
  if (typeof value !== "string") return undefined
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
  const date = new Date(
    dateOnly ? `${value.trim()}T${endOfDay ? "23:59:59" : "12:00:00"}-03:00` : value,
  )
  if (Number.isNaN(date.getTime())) return undefined
  if (dateOnly && argentinaDateKey(date) !== value.trim()) return undefined
  return date.toISOString()
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
