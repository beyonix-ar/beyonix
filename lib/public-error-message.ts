// Capa de mensajes públicos: lo que ve el cliente nunca es un error técnico
// crudo (TypeError, status HTTP, nombres internos). El detalle técnico sigue
// disponible para logs; esto sólo decide qué texto llega a la pantalla.

export const PUBLIC_ERROR_MESSAGES = {
  generic: "No pudimos completar la operación. Intentá nuevamente.",
  shippingQuote: "No pudimos calcular el envío. Intentá nuevamente.",
} as const

const MAX_PUBLIC_MESSAGE_LENGTH = 220

// Palabra completa con límites Unicode: `\b` trata "í" como no-letra y
// "env" matchearía dentro de "envío".
function wholeWords(words: readonly string[]) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(${words.join("|")})(?![\\p{L}\\p{N}_])`, "iu")
}

// Cada grupo describe un tipo de texto técnico. Los mensajes públicos están
// en español y sin identificadores, así que cualquiera de estas señales alcanza
// para descartarlo. "Andreani" y "Mercado Pago" no están: son marcas visibles
// en el checkout y los servidores ya devuelven textos curados que las nombran.
const TECHNICAL_MESSAGE_PATTERNS: Record<string, RegExp> = {
  // Infraestructura y herramientas internas.
  infrastructure: wholeWords([
    "api", "supabase", "postgres", "postgrest", "pgrst", "prisma", "sqlstate", "sql", "rpc", "payload",
    "stack", "json", "fetch", "https?", "status", "token", "webhook", "endpoint", "env",
    "environment", "config", "configuration", "localhost",
  ]),
  // Vocabulario de error en inglés: los textos públicos son en español.
  englishErrorWords: wholeWords([
    "error code", "errno", "exception", "undefined", "null", "nan", "missing", "invalid",
    "required", "failed", "failure", "denied", "unauthorized", "forbidden", "not found",
    "refused", "timed out", "timeout", "unexpected", "cannot", "internal", "server",
    // Postgres.
    "duplicate key", "violates", "constraint", "relation", "column", "row-level security",
    "permission denied", "does not exist", "syntax error",
  ]),
  // Nombres de clases de excepción (PrismaClientKnownRequestError, TypeError,
  // SomethingException): un identificador pegado a "Error"/"Exception". Es
  // sensible a mayúsculas y exige texto antes, así que "Error al…" o "error"
  // sueltos en una frase no cuentan.
  exceptionNames: /\b[A-Za-z][A-Za-z0-9]*?(Error|Exception)\b/,
  // Errores de red/sockets y sus códigos de sistema (ECONNRESET, EPIPE…).
  network: wholeWords([
    "connection reset", "connection refused", "connection closed", "reset by peer",
    "socket hang up", "socket", "broken pipe", "disconnected", "network",
    "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND",
    "EHOSTUNREACH", "EPIPE", "EAI_AGAIN",
  ]),
  // Códigos internos de backend (PGRST116, ERR500).
  backendCodes: /\b[A-Z]{3,}\d{2,}\b/,
  // Status HTTP sueltos ("Error 502"), sin confundirlos con importes ("$1.500").
  httpStatus: /(^|[^\d.,$])[45]\d{2}(?![\d.,])/,
  // Direcciones IP.
  ipAddress: /(^|[^\d.$])\d{1,3}(\.\d{1,3}){3}(?![\d.])/,
  // Identificadores: snake_case y rutas de campo ("origen.codigoPostal").
  identifiers: /\b[a-z0-9]+_[a-z0-9_]+\b|\b[a-z_]+\.[a-z_]+\b/i,
  // Stack traces y texto estructurado ({...}, [object Object], a => b).
  structured: /\n\s*at\s|\bat\s+\S+\s+\(|[{}<>[\]=]|=>|::|\bobject Object\b/,
  // Mensajes de configuración en español.
  configuration: /no está configurad[oa]/i,
}

const TECHNICAL_ERROR_NAMES = new Set([
  "TypeError",
  "SyntaxError",
  "RangeError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AbortError",
])

export function isPublicSafeMessage(message: unknown): message is string {
  if (typeof message !== "string") return false
  const trimmed = message.trim()
  if (!trimmed || trimmed.length > MAX_PUBLIC_MESSAGE_LENGTH) return false
  return !Object.values(TECHNICAL_MESSAGE_PATTERNS).some((pattern) => pattern.test(trimmed))
}

/** Texto apto para el cliente a partir de un mensaje de servidor (o vacío). */
export function toPublicMessage(message: unknown, fallback: string): string {
  return isPublicSafeMessage(message) ? message.trim() : fallback
}

/** Texto apto para el cliente a partir de un error capturado. */
export function getPublicErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  if (TECHNICAL_ERROR_NAMES.has(error.name)) return fallback
  return toPublicMessage(error.message, fallback)
}
