const badWordPatterns = [
  /p[\W_]*u[\W_]*t[\W_]*[oa0@]/i,
  /b[\W_]*o[\W_]*l[\W_]*u[\W_]*d[\W_]*[oa0@]/i,
  /p[\W_]*e[\W_]*l[\W_]*o[\W_]*t[\W_]*u[\W_]*d[\W_]*[oa0@]/i,
  /f[\W_]*o[\W_]*r[\W_]*r[\W_]*[oa0@]/i,
  /m[\W_]*i[\W_]*e[\W_]*r[\W_]*d[\W_]*a/i,
  /i[\W_]*d[\W_]*i[\W_]*o[\W_]*t[\W_]*a/i,
  /g[\W_]*i[\W_]*l/i,
  /p[\W_]*a[\W_]*j[\W_]*e[\W_]*r[\W_]*[oa0@]/i,
]

export function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

export function hasBlockedWords(value: string) {
  const normalized = normalizeText(value)

  return badWordPatterns.some((pattern) => pattern.test(normalized))
}

export function validateUsername(username: string) {
  const cleanUsername = username.trim()

  if (cleanUsername.length < 5) {
    return "El nombre de usuario debe tener al menos 5 caracteres."
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(cleanUsername)) {
    return "Usá solo letras, números, punto, guion o guion bajo."
  }

  if (hasBlockedWords(cleanUsername)) {
    return "Ese nombre de usuario no está permitido."
  }

  return ""
}

export function validatePublicText(value: string) {
  if (hasBlockedWords(value)) {
    return "El texto contiene palabras no permitidas."
  }

  return ""
}
