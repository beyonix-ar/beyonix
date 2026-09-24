/**
 * Borrador de la respuesta del admin en "Atención al cliente", por pedido y
 * reclamo. Vive en el estado del editor y se respalda en sessionStorage para
 * sobrevivir un remount (cambio de pestaña del detalle, recarga de datos que
 * desmonte la vista) sin mezclar borradores entre pedidos/reclamos. Nunca
 * sale del navegador del admin.
 */

export const CLAIM_REPLY_DRAFT_PREFIX = "beyonix:admin-claim-reply:"

export type ClaimReplyDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function getClaimReplyDraftKey(orderId: number, claimId: number) {
  return `${CLAIM_REPLY_DRAFT_PREFIX}${orderId}:${claimId}`
}

/** sessionStorage si está disponible (navegador, sin modo privado bloqueado). */
export function getClaimReplyDraftStorage(): ClaimReplyDraftStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function readClaimReplyDraft(storage: ClaimReplyDraftStorage | null, key: string | null) {
  if (!storage || !key) return ""
  try {
    return storage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

/** Un borrador vacío se elimina: borrar a mano el texto también limpia el respaldo. */
export function writeClaimReplyDraft(
  storage: ClaimReplyDraftStorage | null,
  key: string | null,
  value: string,
) {
  if (!storage || !key) return
  try {
    if (value) storage.setItem(key, value)
    else storage.removeItem(key)
  } catch {
    // Cuota llena / almacenamiento bloqueado: el estado en memoria alcanza.
  }
}
