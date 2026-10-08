import "server-only"

/**
 * Selector de modo de la Content-Security-Policy, controlado por la
 * variable de entorno server-side `CSP_MODE`.
 *
 * En producción, la política auditada se aplica por defecto. Un valor
 * explícito "report-only" permite volver temporalmente al modo de diagnóstico.
 * En desarrollo se mantiene Report-Only para no bloquear HMR.
 */
export type CspMode = "enforce" | "report-only"

export function resolveCspMode(
  rawValue: string | undefined | null,
  nodeEnv = process.env.NODE_ENV,
): CspMode {
  const value = rawValue?.trim()

  if (value === "enforce") return "enforce"
  if (value === "report-only") return "report-only"

  if (value) {
    console.warn(
      `CSP_MODE="${value}" no es un valor válido (usar "enforce" o "report-only"). Aplicando el modo por defecto del entorno.`,
    )
  }

  return nodeEnv === "production" ? "enforce" : "report-only"
}
