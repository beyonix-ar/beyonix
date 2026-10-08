import { NextResponse, type NextRequest } from "next/server"

/**
 * Receptor de reportes de violaciones CSP (enforcement o Report-Only).
 *
 * - No persiste nada (ni DB ni archivo): sólo un console.warn acotado del lado
 *   servidor con campos no sensibles.
 * - No requiere autenticación (los navegadores envían este POST sin
 *   credenciales ni forma de agregarlas), pero tampoco confía en el body:
 *   se cappea el tamaño, se valida forma, y sólo se extraen los campos
 *   documentados del formato `csp-report` en vez de loguear el objeto crudo.
 * - Nunca refleja el contenido recibido en la respuesta (siempre 204 vacío),
 *   así que no hay superficie de reflected-XSS ni de abuso para inflar
 *   respuestas.
 */

const MAX_BODY_BYTES = 8_000
const MAX_LOGS_PER_MINUTE = 60
let logWindowStart = 0
let logsInWindow = 0

type CspReportBody = {
  "csp-report"?: {
    "document-uri"?: unknown
    "violated-directive"?: unknown
    "blocked-uri"?: unknown
    "effective-directive"?: unknown
    disposition?: unknown
  }
}

function truncate(value: unknown, maxLength: number) {
  if (typeof value !== "string") return null
  return value.slice(0, maxLength)
}

function pathnameOnly(value: unknown) {
  if (typeof value !== "string") return null
  try {
    return new URL(value).pathname.slice(0, 200)
  } catch {
    return null
  }
}

function originOnly(value: unknown) {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin.slice(0, 200)
      : url.protocol.slice(0, 20)
  } catch {
    return null
  }
}

function canLogReport(now = Date.now()) {
  if (now - logWindowStart >= 60_000) {
    logWindowStart = now
    logsInWindow = 0
  }
  if (logsInWindow >= MAX_LOGS_PER_MINUTE) return false
  logsInWindow += 1
  return true
}

async function readLimitedBody(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0")

  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 })
  }

  try {
    const raw = await readLimitedBody(request)
    if (raw === null) {
      return new NextResponse(null, { status: 413 })
    }

    const parsed = JSON.parse(raw) as CspReportBody
    const report = parsed["csp-report"]

    if (report && typeof report === "object" && canLogReport()) {
      console.warn("CSP_VIOLATION", {
        documentPath: pathnameOnly(report["document-uri"]),
        violatedDirective: truncate(report["violated-directive"], 100),
        effectiveDirective: truncate(report["effective-directive"], 100),
        blockedOrigin: originOnly(report["blocked-uri"]),
        disposition: truncate(report.disposition, 20),
      })
    }
  } catch {
    // Body ausente, no-JSON o malformado: se ignora silenciosamente, nunca
    // se le da información de vuelta al emisor del reporte.
  }

  return new NextResponse(null, { status: 204 })
}

export async function GET() {
  return new NextResponse(null, { status: 405 })
}
