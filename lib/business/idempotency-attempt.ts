export interface IdempotencyAttempt {
  payloadFingerprint: string
  key: string
}

export function getOrCreateIdempotencyAttempt(
  current: IdempotencyAttempt | null,
  payload: Record<string, unknown>,
  namespace: string = payload.kind === "expense" ? "expense" : "purchase",
): IdempotencyAttempt {
  const payloadFingerprint = JSON.stringify(payload)
  if (current?.payloadFingerprint === payloadFingerprint) return current

  return {
    payloadFingerprint,
    key: `${namespace}:${crypto.randomUUID()}`,
  }
}
