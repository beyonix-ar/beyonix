import { classifyReturnStock } from "@/lib/inventory/stock-metrics"

function text(value: unknown) {
  return value == null ? "" : String(value).trim()
}

function number(value: unknown) {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function isMercadoLibreReturn(row: { raw_data?: unknown }) {
  const raw =
    row.raw_data && typeof row.raw_data === "object"
      ? (row.raw_data as { parsed?: Record<string, unknown> })
      : {}
  const parsed = raw.parsed ?? {}
  const status = text(parsed.status).toLocaleLowerCase("es")

  return (
    status.includes("devol") ||
    status.includes("reembolso") ||
    number(parsed.cancellations_refunds) < 0 ||
    Boolean(text(parsed.return_delivered_date)) ||
    Boolean(text(parsed.return_tracking_number))
  )
}

export function getMercadoLibrePendingReturnUnits(row: {
  quantity?: unknown
  return_review?: {
    received_quantity?: unknown
    sellable_quantity?: unknown
    discounted_quantity?: unknown
    non_sellable_quantity?: unknown
  } | null
}) {
  const review = row.return_review

  return classifyReturnStock(
    review
      ? {
          received: review.received_quantity,
          sellable: review.sellable_quantity,
          discounted: review.discounted_quantity,
          nonSellable: review.non_sellable_quantity,
        }
      : { received: row.quantity },
  ).pendingReview
}
