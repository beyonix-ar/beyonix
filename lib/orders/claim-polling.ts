const TERMINAL_CLAIM_STATUSES = ["cerrado", "rechazado"]

export function isTerminalClaimStatus(status: string | null | undefined): boolean {
  return Boolean(status) && TERMINAL_CLAIM_STATUSES.includes(status as string)
}

/**
 * Admin (AdminClaimManager): un único claim seleccionado. Se sigue
 * escuchando el foco de la ventana como red de seguridad barata incluso
 * cuando esto devuelve false; lo único que se evita es el intervalo
 * recurrente para un caso que ya terminó.
 */
export function shouldPollSingleClaim(status: string | null | undefined): boolean {
  return !isTerminalClaimStatus(status)
}

/**
 * Cliente (CustomerClaimExperience): puede haber varios claims por pedido.
 * Se sigue polleando mientras exista al menos uno sin terminar (o mientras
 * todavía no se cargó ninguno), para no perder una reapertura o un caso
 * nuevo.
 */
export function shouldPollClaimList(
  claims: ReadonlyArray<{ status: string | null | undefined }>,
): boolean {
  if (claims.length === 0) return true

  return !claims.every((claim) => isTerminalClaimStatus(claim.status))
}

const CUSTOMER_CLAIM_ACTIVE_POLL_MS = 20_000
const CUSTOMER_CLAIM_TERMINAL_POLL_MS = 5 * 60_000

/**
 * Intervalo de polling para el cliente. A diferencia de `shouldPollClaimList`
 * (que decide si el intervalo "activo" corre o no), esto nunca devuelve
 * `null`: aun con todos los claims en estado terminal, un cierre puede
 * reabrirse desde el lado administrativo, y el cliente puede dejar la
 * pestaña enfocada sin generar un evento `focus` que lo detecte. Se
 * mantiene un chequeo liviano de baja frecuencia como red de seguridad.
 */
export function getCustomerClaimPollIntervalMs(
  claims: ReadonlyArray<{ status: string | null | undefined }>,
): number {
  return shouldPollClaimList(claims)
    ? CUSTOMER_CLAIM_ACTIVE_POLL_MS
    : CUSTOMER_CLAIM_TERMINAL_POLL_MS
}
