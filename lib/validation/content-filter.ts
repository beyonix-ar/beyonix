const letterAliases: Record<string, string> = {
  "0": "o",
  "1": "i",
  "!": "i",
  "|": "i",
  "3": "e",
  "4": "a",
  "@": "a",
  "5": "s",
  "$": "s",
  "7": "t",
  "+": "t",
  "8": "b",
  "9": "g",
}

const blockedRoots = [
  "anal",
  "ano",
  "ass",
  "bitch",
  "bolud",
  "chot",
  "concha",
  "culo",
  "dick",
  "forr",
  "fuck",
  "gil",
  "idiot",
  "mierda",
  "ort",
  "pajer",
  "pelotud",
  "pene",
  "poronga",
  "pussy",
  "put",
  "verga",
  "vagina",
  "vagin",
  "vag1n",
  "v4gin",
  "v4g1n",
  "whore",
]

export function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

function normalizeForModeration(value: string) {
  return normalizeText(value)
    .replace(/[014@!|35$7+89]/g, (char) => letterAliases[char] ?? char)
    .replace(/[^a-z]/g, "")
}

export function hasBlockedWords(value: string) {
  const compact = normalizeForModeration(value)

  return blockedRoots.some((word) => compact.includes(word))
}

export function validateUsername(username: string) {
  const cleanUsername = username.trim()

  if (cleanUsername.length < 5) {
    return "El nombre de usuario debe tener al menos 5 caracteres."
  }

  if (cleanUsername.length > 18) {
    return "El nombre de usuario no puede superar los 18 caracteres."
  }

  if (!/^[\p{L}\p{M}0-9._-]+$/u.test(cleanUsername)) {
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
