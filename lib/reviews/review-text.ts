import { validatePublicText } from "../validation/content-filter.ts"

export const REVIEW_COMMENT_MIN_LENGTH = 8
export const REVIEW_COMMENT_MAX_LENGTH = 150

const MIN_DISTINCT_CHARACTERS = 5
const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"]
const KEYBOARD_RUN_LENGTH = 4
const KEYBOARD_RUNS = new Set(
  KEYBOARD_ROWS.flatMap((row) => {
    const runs: string[] = []
    for (const source of [row, [...row].reverse().join("")]) {
      for (let index = 0; index + KEYBOARD_RUN_LENGTH <= source.length; index += 1) {
        runs.push(source.slice(index, index + KEYBOARD_RUN_LENGTH))
      }
    }
    return runs
  }),
)

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/
const PHONE_PATTERN = /(?:\d[\s.-]?){8,}/
const LONG_NUMBER_PATTERN = /\b\d{6,}\b/
const ADDRESS_PATTERN =
  /\b(calle|avenida|av\.?|piso|depto|departamento|dpto|casa|altura|cp|c\.p\.)\s*(n[°º.]?\s*)?\d+/i

/** Letras y números del comentario, en minúscula y sin diacríticos. */
function getReviewTextCore(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "")
}

function countUsefulCharacters(value: string) {
  return (value.match(/[\p{L}\p{N}]/gu) ?? []).length
}

/** Una misma secuencia repetida al menos 3 veces ("jajaja", "asdfasdfasdf"). */
function isRepeatedSequence(core: string) {
  for (let period = 1; period <= core.length / 3; period += 1) {
    let periodic = true
    for (let index = period; index < core.length; index += 1) {
      if (core[index] !== core[index % period]) {
        periodic = false
        break
      }
    }
    if (periodic) return true
  }
  return false
}

function getKeyboardCoverage(core: string) {
  const covered = new Array<boolean>(core.length).fill(false)
  for (let index = 0; index + KEYBOARD_RUN_LENGTH <= core.length; index += 1) {
    if (!KEYBOARD_RUNS.has(core.slice(index, index + KEYBOARD_RUN_LENGTH))) continue
    for (let offset = 0; offset < KEYBOARD_RUN_LENGTH; offset += 1) covered[index + offset] = true
  }
  return covered.filter(Boolean).length / core.length
}

function getLongestRunShare(core: string) {
  let longest = 0
  let current = 0
  for (let index = 0; index < core.length; index += 1) {
    current = index > 0 && core[index] === core[index - 1] ? current + 1 : 1
    longest = Math.max(longest, current)
  }
  return longest / core.length
}

/**
 * Detecta texto sin contenido real (determinista, sin servicios externos):
 * sin letras (solo números/símbolos), poca diversidad de caracteres,
 * secuencias cortas repetidas ("jajaja", "asdfasdf"), un mismo carácter
 * dominante o recorridos de teclado ("qwerty", "asdfgh").
 */
export function isMeaningfulReviewText(value: string) {
  const core = getReviewTextCore(value)

  if (core.length < REVIEW_COMMENT_MIN_LENGTH) return false
  if (!/\p{L}/u.test(core)) return false
  if (new Set(core).size < MIN_DISTINCT_CHARACTERS) return false
  if (isRepeatedSequence(core)) return false
  if (getLongestRunShare(core) >= 0.5) return false
  if (getKeyboardCoverage(core) >= 0.5) return false

  return true
}

export function containsPrivateReviewData(value: string) {
  return (
    EMAIL_PATTERN.test(value) ||
    PHONE_PATTERN.test(value) ||
    LONG_NUMBER_PATTERN.test(value) ||
    ADDRESS_PATTERN.test(value)
  )
}

export type ReviewCommentValidation =
  | { error: string; comment: "" }
  | { error: ""; comment: string }

/**
 * Pipeline única de validación del comentario de una reseña (cliente y
 * servidor): obligatorio, largo, contenido real, moderación de lenguaje y
 * datos privados.
 */
export function validateReviewComment(value: unknown): ReviewCommentValidation {
  const comment = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""

  if (!comment) {
    return { error: "Escribí un comentario sobre tu experiencia.", comment: "" }
  }

  if (comment.length > REVIEW_COMMENT_MAX_LENGTH) {
    return {
      error: `La reseña puede tener hasta ${REVIEW_COMMENT_MAX_LENGTH} caracteres.`,
      comment: "",
    }
  }

  if (countUsefulCharacters(comment) < REVIEW_COMMENT_MIN_LENGTH) {
    return {
      error: `El comentario tiene que tener al menos ${REVIEW_COMMENT_MIN_LENGTH} letras o números.`,
      comment: "",
    }
  }

  if (!isMeaningfulReviewText(comment)) {
    return {
      error: "Contanos con palabras cómo fue tu experiencia.",
      comment: "",
    }
  }

  const moderationError = validatePublicText(comment)
  if (moderationError) return { error: moderationError, comment: "" }

  if (containsPrivateReviewData(comment)) {
    return {
      error: "No incluyas emails, teléfonos ni direcciones en la reseña.",
      comment: "",
    }
  }

  return { error: "", comment }
}
