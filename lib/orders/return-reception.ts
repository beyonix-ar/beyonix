/**
 * Estados de recepción que implican que el producto devuelto fue
 * físicamente recibido y revisado. Es la única condición bajo la cual
 * `stock_destination` tiene un efecto real: ver
 * app/api/admin/orders/[id]/credit-note/route.ts, donde los movimientos de
 * stock (reingreso vendible, stock con observaciones, fallado, etc.) solo se
 * ejecutan cuando la recepción está en uno de estos estados.
 */
export const PHYSICALLY_RECEIVED_RECEPTION_STATUSES = [
  "recibido_revision",
  "producto_aprobado",
  "producto_rechazado",
  "aprobado_parcial",
] as const

export function isPhysicallyReceivedStatus(receptionStatus: string): boolean {
  return (
    PHYSICALLY_RECEIVED_RECEPTION_STATUSES as readonly string[]
  ).includes(receptionStatus)
}

/**
 * Normaliza `stockDestination` a un valor neutro cuando la recepción no
 * requiere revisión física, para no persistir un valor stale que el motor
 * de stock nunca va a leer. Se usa tanto en el frontend (al cambiar el
 * estado de recepción) como en el backend (al recibir el payload), como
 * defensa en profundidad.
 */
export function normalizeStockDestination(
  receptionStatus: string,
  stockDestination: string,
): string {
  return isPhysicallyReceivedStatus(receptionStatus)
    ? stockDestination
    : "pendiente_revision"
}
