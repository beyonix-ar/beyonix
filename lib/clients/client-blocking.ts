export type ClientRiskStatus = "normal" | "tedioso" | "complicado"
export type BlockIdentifierType = "email" | "username" | "phone"

export interface BlockedClientIdentifier {
  id: number
  identifier_type: BlockIdentifierType
  identifier_value: string
  reason: string | null
  source_profile_id: string | null
  created_at: string
  created_by: string | null
}

export function normalizeBlockIdentifier(
  type: BlockIdentifierType,
  value: string
) {
  const clean = value.trim().toLowerCase()

  if (type === "phone") {
    return clean.replace(/\D/g, "")
  }

  return clean
}

export function getClientBlockIdentifiers(input: {
  email?: string | null
  username?: string | null
  phone?: string | null
}) {
  const identifiers: Array<{
    identifier_type: BlockIdentifierType
    identifier_value: string
  }> = []

  const email = normalizeBlockIdentifier("email", input.email ?? "")
  const username = normalizeBlockIdentifier("username", input.username ?? "")
  const phone = normalizeBlockIdentifier("phone", input.phone ?? "")

  if (email) {
    identifiers.push({ identifier_type: "email", identifier_value: email })
  }

  if (username) {
    identifiers.push({ identifier_type: "username", identifier_value: username })
  }

  if (phone) {
    identifiers.push({ identifier_type: "phone", identifier_value: phone })
  }

  return identifiers
}
