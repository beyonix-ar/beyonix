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

// Texto libre con varias palabras: buscar las raíces sobre el texto compactado
// bloquea palabras comunes ("transporte" contiene "ort", "hermano"/"año"
// contienen "ano", "computadora" contiene "put"). Por eso se evalúa por
// palabra: las raíces cortas solo al inicio de la palabra y las ambiguas como
// palabra completa. Las raíces largas se siguen buscando también en el texto
// compactado para detectar insultos separados con espacios o símbolos.
const PUBLIC_TEXT_WORD_SEPARATOR = /[\s,.;:?¿¡"'()[\]{}\-_/\\]+/
const exactWordRoots = new Set(["ano", "anal", "ass"])
const SHORT_ROOT_MAX_LENGTH = 4
const COMPACT_ROOT_MIN_LENGTH = 6

function getPublicTextWords(value: string) {
  const tokens = value
    .toLowerCase()
    .replace(/ñ/g, "ny")
    .split(PUBLIC_TEXT_WORD_SEPARATOR)
    .map(normalizeForModeration)
    .filter(Boolean)
  const words: string[] = []
  let spelledOut = ""

  for (const token of tokens) {
    if (token.length === 1) {
      spelledOut += token
      continue
    }
    if (spelledOut) words.push(spelledOut)
    spelledOut = ""
    words.push(token)
  }
  if (spelledOut) words.push(spelledOut)

  return words
}

function isBlockedPublicWord(word: string) {
  return blockedRoots.some((root) => {
    if (exactWordRoots.has(root)) return word === root || word === `${root}s`
    if (root.length <= SHORT_ROOT_MAX_LENGTH) return word.startsWith(root)
    return word.includes(root)
  })
}

function hasBlockedPublicText(value: string) {
  const compact = normalizeForModeration(value.toLowerCase().replace(/ñ/g, "ny"))

  return (
    blockedRoots.some(
      (root) => root.length >= COMPACT_ROOT_MIN_LENGTH && compact.includes(root),
    ) || getPublicTextWords(value).some(isBlockedPublicWord)
  )
}

export function validatePublicText(value: string) {
  if (hasBlockedPublicText(value)) {
    return "El texto contiene palabras no permitidas."
  }

  return ""
}
