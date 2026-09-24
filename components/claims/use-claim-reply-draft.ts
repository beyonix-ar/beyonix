"use client"

import { useCallback, useState } from "react"

import {
  getClaimReplyDraftKey,
  getClaimReplyDraftStorage,
  readClaimReplyDraft,
  writeClaimReplyDraft,
} from "@/lib/admin/claim-reply-draft"

/**
 * Texto que el admin está escribiendo para UN reclamo. Las recargas de datos
 * (polling del reclamo, realtime, mensaje nuevo del cliente, cambio de
 * estado) no lo tocan: el valor sólo depende de (orderId, claimId).
 * - Cambiar de pedido/reclamo carga el borrador de ESE reclamo (o vacío).
 * - setDraft escribe estado + respaldo; "" (borrado manual) elimina el respaldo.
 * - clearDraft se usa sólo después de un envío exitoso.
 */
export function useClaimReplyDraft(orderId: number, claimId: number | null) {
  const scope = claimId == null ? null : getClaimReplyDraftKey(orderId, claimId)
  const [draft, setDraftState] = useState(() => ({
    scope,
    value: readClaimReplyDraft(getClaimReplyDraftStorage(), scope),
  }))

  // Reset por cambio de pedido/reclamo durante el render (patrón de React
  // para derivar estado de props), sin un efecto que pise lo escrito.
  let current = draft
  if (draft.scope !== scope) {
    current = { scope, value: readClaimReplyDraft(getClaimReplyDraftStorage(), scope) }
    setDraftState(current)
  }

  const setDraft = useCallback(
    (value: string) => {
      setDraftState({ scope, value })
      writeClaimReplyDraft(getClaimReplyDraftStorage(), scope, value)
    },
    [scope],
  )

  const clearDraft = useCallback(() => {
    setDraftState((previous) => (previous.scope === scope ? { scope, value: "" } : previous))
    writeClaimReplyDraft(getClaimReplyDraftStorage(), scope, "")
  }, [scope])

  return [current.value, setDraft, clearDraft] as const
}
