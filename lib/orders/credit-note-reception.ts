/**
 * Auditoría 4/7 (Fase 2, puntos 4 y 5): reglas puras de credit-note/route.ts
 * para cruzar NC contra recepción física y endurecer reception_exception.
 * Extraídas para poder testearlas con ejecución real (no sólo revisión de
 * código) -- app/api/admin/orders/[id]/credit-note/route.ts depende de ARCA
 * y de una sesión admin real, así que no es practicable ejecutarlo entero
 * en un test; esta lógica sí lo es.
 */

/**
 * Cuántas unidades de un order_item, ya físicamente recibidas, todavía
 * pueden acreditarse en una NC nueva -- descontando lo que otras notas
 * `processing`/`authorized` ya comprometieron para ese mismo ítem. Nunca
 * negativo: si lo ya comprometido supera lo recibido (no debería pasar,
 * pero no se confía en eso), no queda nada disponible.
 */
export function getAvailableToCreditQuantity(
  receivedQuantity: number,
  committedQuantity: number,
): number {
  return Math.max(receivedQuantity - committedQuantity, 0)
}

/**
 * `null` si la excepción administrativa es válida (o no se está usando);
 * el mensaje de error a devolver si no lo es. reception_exception=true
 * siempre exige un motivo real (mínimo 10 caracteres) -- no puede ser un
 * booleano sin rastro.
 */
export function getReceptionExceptionError(
  receptionException: boolean,
  reason: string | null,
): string | null {
  if (!receptionException) return null
  if (!reason || reason.length < 10) {
    return "Indicá el motivo de la excepción administrativa (mínimo 10 caracteres): por qué se autoriza sin recepción física aprobada."
  }
  return null
}

/**
 * `null` si se puede continuar; el mensaje de error (409) si la NC está
 * bloqueada porque el producto todavía no fue recibido/aprobado y no se
 * invocó la excepción administrativa.
 */
export function getReceptionApprovalGateError(
  receptionApproved: boolean,
  receptionException: boolean,
): string | null {
  if (receptionApproved || receptionException) return null
  return "La nota queda bloqueada hasta recibir y aprobar el producto. Usá la excepción administrativa únicamente si corresponde."
}
