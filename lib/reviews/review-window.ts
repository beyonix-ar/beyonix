// Plazo para dejar una reseña: desde `ordenes.delivered_at` (la misma fecha de
// entrega que usan reclamos y garantías) hasta delivered_at + 15 días,
// inclusive. Se compara en instantes absolutos (timestamptz / epoch ms), así
// que no depende de la zona horaria del navegador ni del servidor. La base
// aplica la misma regla en el trigger de `reviews` (interval '15 days', sesión
// UTC).
export const REVIEW_WINDOW_DAYS = 15
const REVIEW_WINDOW_MS = REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000

export type ReviewWindowStatus = "open" | "not_delivered" | "expired"

export type ReviewWindow = {
  status: ReviewWindowStatus
  deadline: string | null
}

export const REVIEW_WINDOW_MESSAGES: Record<Exclude<ReviewWindowStatus, "open">, string> = {
  not_delivered: "Vas a poder dejar tu reseña cuando el pedido figure como entregado.",
  expired: "El período para dejar una reseña finalizó.",
}

export function getReviewWindow(
  order: { estado?: string | null; delivered_at?: string | null },
  now = Date.now(),
): ReviewWindow {
  const deliveredAt = order.delivered_at ? Date.parse(order.delivered_at) : Number.NaN

  if (order.estado?.toLowerCase() === "cancelado" || !Number.isFinite(deliveredAt) || now < deliveredAt) {
    return { status: "not_delivered", deadline: null }
  }

  const deadline = deliveredAt + REVIEW_WINDOW_MS

  return {
    status: now <= deadline ? "open" : "expired",
    deadline: new Date(deadline).toISOString(),
  }
}
