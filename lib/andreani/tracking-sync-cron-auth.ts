import "server-only"

export function isAndreaniTrackingCronAuthorized(
  authorization: string | null,
  configuredSecret: string | undefined,
): boolean {
  const cronSecret = configuredSecret?.trim()

  if (!cronSecret) return false

  return authorization === `Bearer ${cronSecret}`
}
