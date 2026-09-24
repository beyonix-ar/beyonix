/**
 * Mensajes de BEYONIX sin leer en el reclamo que ve el cliente. Fuente de
 * verdad persistente: order_claim_customer_reads.last_read_at (server-side),
 * que la API expone como `customer_last_read_at` en cada reclamo del propio
 * cliente. Nunca cuenta mensajes del cliente.
 */

export const CUSTOMER_CLAIM_AUTHOR_ROLE = "cliente"
export const HELP_MESSAGE_FAILURE_TYPE = "consulta_pedido"
const CANCELLATION_FAILURE_TYPE = "cancelar_compra"
const TERMINAL_CLAIM_STATUSES = ["cerrado", "rechazado"]
const ACTIVE_CLAIM_STATUSES = [
  "recibido",
  "en_revision",
  "falta_informacion",
  "aprobado",
  "reintegro_pendiente",
  "cambio_pendiente",
  "cupon_pendiente",
  "reemplazo_enviado",
]

export interface ClaimUnreadMessage {
  id?: number
  author_role?: string | null
  created_at: string
}

export interface ClaimUnreadSource {
  id?: number
  status?: string | null
  failure_type?: string | null
  customer_last_read_at?: string | null
  order_claim_messages?: ClaimUnreadMessage[] | null
}

/**
 * El reclamo que muestra /cuenta/compras/[id]/ayuda (CustomerClaimExperience):
 * el activo, o el primero visible. Compartido para que el badge de "Ver
 * reclamo" cuente exactamente lo que el cliente va a ver al abrirlo.
 */
export function selectCustomerDisplayedClaim<T extends ClaimUnreadSource>(
  claims: readonly T[],
  { canCreatePostDeliveryClaim }: { canCreatePostDeliveryClaim: boolean },
): T | undefined {
  const visible = claims.filter((claim) => claim.failure_type !== CANCELLATION_FAILURE_TYPE)
  const displayable = canCreatePostDeliveryClaim
    ? visible.filter(
        (claim) =>
          claim.failure_type !== HELP_MESSAGE_FAILURE_TYPE ||
          !TERMINAL_CLAIM_STATUSES.includes(claim.status ?? ""),
      )
    : visible
  return (
    displayable.find((claim) => ACTIVE_CLAIM_STATUSES.includes(claim.status ?? "")) ??
    displayable[0]
  )
}

function isBeyonixMessage(message: ClaimUnreadMessage) {
  return (message.author_role ?? "") !== CUSTOMER_CLAIM_AUTHOR_ROLE
}

export function countUnreadBeyonixMessages(claim: ClaimUnreadSource | null | undefined) {
  if (!claim) return 0
  const lastRead = Date.parse(claim.customer_last_read_at ?? "")
  return (claim.order_claim_messages ?? []).filter((message) => {
    if (!isBeyonixMessage(message)) return false
    if (!Number.isFinite(lastRead)) return true
    return Date.parse(message.created_at) > lastRead
  }).length
}

/** Última respuesta de BEYONIX visible: hasta ella se marca como leído. */
export function getLatestBeyonixMessage(claim: ClaimUnreadSource | null | undefined) {
  return (claim?.order_claim_messages ?? [])
    .filter(isBeyonixMessage)
    .reduce<ClaimUnreadMessage | null>(
      (latest, message) =>
        !latest || Date.parse(message.created_at) > Date.parse(latest.created_at) ? message : latest,
      null,
    )
}

export function formatUnreadBadgeCount(count: number) {
  if (!Number.isFinite(count) || count <= 0) return null
  return count > 99 ? "99+" : String(Math.floor(count))
}
