import "server-only"

import { isCronRequestAuthorized } from "../auth/cron-auth.ts"

/** Alias histórico: la regla vive en `lib/auth/cron-auth.ts`, compartida por todos los crons. */
export function isAndreaniTrackingCronAuthorized(
  authorization: string | null,
  configuredSecret: string | undefined,
): boolean {
  return isCronRequestAuthorized(authorization, configuredSecret)
}
