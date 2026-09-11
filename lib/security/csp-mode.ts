import "server-only"

/**
 * Selector de modo de la Content-Security-Policy, controlado por la
 * variable de entorno server-side `CSP_MODE`.
 *
 * Fail-safe deliberado: cualquier valor que no sea exactamente "enforce"
 * (ausente, vacío, typo, mayúsculas/minúsculas distintas, etc.) resuelve a
 * "report-only". Un error de configuración nunca debe activar enforcing
 * por accidente -- sólo un "enforce" explícito y exacto lo hace.
 */
export type CspMode = "enforce" | "report-only"

export function resolveCspMode(rawValue: string | undefined | null): CspMode {
  const value = rawValue?.trim()

  if (value === "enforce") return "enforce"

  if (value && value !== "report-only") {
    console.warn(
      `CSP_MODE="${value}" no es un valor válido (usar "enforce" o "report-only"). Aplicando fail-safe: report-only.`,
    )
  }

  return "report-only"
}
