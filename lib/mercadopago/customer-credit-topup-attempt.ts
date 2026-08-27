import "server-only"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function getCustomerCreditTopupPreferenceIdempotencyKey(
  topupId: string,
) {
  const normalizedTopupId = topupId.trim().toLowerCase()
  if (!UUID_PATTERN.test(normalizedTopupId)) {
    throw new Error("El intento de carga no tiene una identidad válida.")
  }

  return `beyonix-credit-topup-${normalizedTopupId}`
}
