function getTime(value?: string | null) {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : 0
}

/**
 * Única regla de "este reclamo necesita que el Admin haga algo" (campana,
 * contador del pedido y punto rojo de Atención al cliente). Un reclamo
 * finalizado, rechazado o cancelado (status 'cerrado' + cancelled_at) nunca
 * avisa, aunque haya quedado un admin_needs_action viejo. Uno en curso avisa
 * sólo si la base lo marcó, si nunca se revisó o si el cliente escribió
 * después de la última respuesta: esperar a Andreani no es una acción.
 */
export function claimNeedsAdminAttention(claim: {
  admin_needs_action?: boolean | null
  first_reviewed_at?: string | null
  last_customer_message_at?: string | null
  last_admin_response_at?: string | null
  status?: string | null
}) {
  if (["cerrado", "rechazado"].includes(claim.status ?? "")) return false
  if (claim.admin_needs_action) return true
  if (claim.status === "recibido" || (!claim.status && !claim.first_reviewed_at)) return true
  return getTime(claim.last_customer_message_at) > getTime(claim.last_admin_response_at)
}
