import "server-only"

export const DEFAULT_PRODUCT_WARRANTY_MONTHS = 6

export type OrderItemWarrantyStatus =
  | "pending_delivery"
  | "active"
  | "expired"
  | "voided"

export function addCalendarMonths(date: Date, months: number) {
  const result = new Date(date.getTime())
  const originalDay = result.getUTCDate()

  result.setUTCMonth(result.getUTCMonth() + months)

  if (result.getUTCDate() !== originalDay) {
    result.setUTCDate(0)
  }

  return result
}

export function getWarrantyExpiration(deliveredAt: string, months = DEFAULT_PRODUCT_WARRANTY_MONTHS) {
  return addCalendarMonths(new Date(deliveredAt), months).toISOString()
}

export function normalizeWarrantyStatus(value: unknown): OrderItemWarrantyStatus | null {
  return value === "pending_delivery" ||
    value === "active" ||
    value === "expired" ||
    value === "voided"
    ? value
    : null
}
