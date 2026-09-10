import { NextResponse, type NextRequest } from "next/server"

/**
 * Receptor de reportes de violaciones CSP (Content-Security-Policy-Report-Only).
 * Deliberadamente mínimo mientras la política está en modo Report-Only:
 *
 * - No persiste nada (ni DB ni archivo): sólo un console.warn del lado
 *   servidor con campos no sensibles, para poder revisar logs y decidir
 *   cuándo pasar a enforcing (ver informe de la tarea).
 * - No requiere autenticación (los navegadores envían este POST sin
 *   credenciales ni forma de agregarlas), pero tampoco confía en el body:
 *   se cappea el tamaño, se valida forma, y sólo se extraen los campos
 *   documentados del formato `csp-report` en vez de loguear el objeto crudo.
 * - Nunca refleja el contenido recibido en la respuesta (siempre 204 vacío),
 *   así que no hay superficie de reflected-XSS ni de abuso para inflar
 *   respuestas.
 */

const MAX_BODY_BYTES = 8_000

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
    return truncate(value, 200)
  }
}

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0")

  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 })
  }

  try {
    const raw = await request.text()

    if (raw.length > MAX_BODY_BYTES) {
      return new NextResponse(null, { status: 413 })
    }

    const parsed = JSON.parse(raw) as CspReportBody
    const report = parsed["csp-report"]

    if (report && typeof report === "object") {
      console.warn("CSP_REPORT_ONLY_VIOLATION", {
        documentPath: pathnameOnly(report["document-uri"]),
        violatedDirective: truncate(report["violated-directive"], 100),
        effectiveDirective: truncate(report["effective-directive"], 100),
        blockedUri: truncate(report["blocked-uri"], 200),
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
