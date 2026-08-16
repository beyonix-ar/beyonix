export interface IdempotencyAttempt {
  payloadFingerprint: string
  key: string
}

export function getOrCreateIdempotencyAttempt(
  current: IdempotencyAttempt | null,
  payload: Record<string, unknown>,
): IdempotencyAttempt {
  const payloadFingerprint = JSON.stringify(payload)
  if (current?.payloadFingerprint === payloadFingerprint) return current

  const namespace = payload.kind === "expense" ? "expense" : "purchase"

  return {
    payloadFingerprint,
    key: `${namespace}:${crypto.randomUUID()}`,
  }
}
