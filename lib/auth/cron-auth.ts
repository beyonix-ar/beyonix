import "server-only"

/**
 * Autorización de los endpoints de cron. FALLA CERRADO: si `CRON_SECRET` no
 * está configurado (o quedó vacío) NO se autoriza a nadie, en vez de dejar el
 * endpoint abierto a internet. Un cron mal configurado tiene que dejar de
 * correr, nunca volverse público -- estos endpoints cancelan órdenes y
 * sincronizan estados de envío.
 */
export function isCronRequestAuthorized(
  authorization: string | null,
  configuredSecret: string | undefined,
): boolean {
  const cronSecret = configuredSecret?.trim()

  if (!cronSecret) return false

  return authorization === `Bearer ${cronSecret}`
}
