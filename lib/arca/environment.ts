/**
 * Ambiente ARCA de un comprobante. Homologación y producción numeran por
 * separado: un comprobante sólo se identifica por ambiente + punto + tipo +
 * número (migración 20260927120000).
 */
export type ArcaEnvironment = "homologation" | "production"

/**
 * Configuración ARCA incompleta o incoherente. Se lanza ANTES de contactar a
 * WSAA/WSFE: nunca se emite con una configuración dudosa. Los mensajes nunca
 * incluyen PEM, claves, passphrase ni otros secretos.
 */
export class ArcaConfigurationError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(`La configuración de ARCA es inválida: ${errors.join(" ")}`)
    this.name = "ArcaConfigurationError"
    this.errors = errors
  }
}

/**
 * ARCA_ENV explícito y exacto: sólo "homologation" o "production". Ausente,
 * vacío o con cualquier otro valor es un error: no existe un ambiente por
 * defecto (antes caía a homologación en silencio).
 */
export function readArcaEnvironment(
  value: string | undefined,
): { environment: ArcaEnvironment; error?: never } | { environment?: never; error: string } {
  const normalized = value?.trim()
  if (!normalized) {
    return { error: "ARCA_ENV no está configurada: definí homologation (pruebas) o production (fiscal)." }
  }
  if (normalized === "homologation" || normalized === "production") {
    return { environment: normalized }
  }
  return { error: "ARCA_ENV tiene un valor inválido: sólo se acepta homologation o production." }
}

/**
 * ÚNICA fuente del ambiente activo: endpoints WSAA/WSFE, clave del TA
 * persistido y ambiente guardado en cada comprobante salen de acá. Sin
 * ARCA_ENV válido lanza ArcaConfigurationError.
 */
export function getConfiguredArcaEnvironment(value = process.env.ARCA_ENV): ArcaEnvironment {
  const result = readArcaEnvironment(value)
  if (result.error !== undefined) throw new ArcaConfigurationError([result.error])
  return result.environment
}

export function parseArcaEnvironment(value: unknown): ArcaEnvironment | null {
  return value === "homologation" || value === "production" ? value : null
}

/**
 * Sólo un comprobante marcado 'production' es fiscal. Sin ambiente se trata
 * como prueba: nunca se presenta como válido algo que no se puede probar.
 */
export function isFiscalArcaVoucher(environment: unknown) {
  return parseArcaEnvironment(environment) === "production"
}

export const ARCA_TEST_VOUCHER_LABEL = "Comprobante de prueba (ARCA homologación)"
export const ARCA_TEST_VOUCHER_NOTICE =
  "Comprobante emitido en el ambiente de homologación de ARCA. Sin validez fiscal."
export const ARCA_HOMOLOGATION_ENVIRONMENT_WARNING =
  "Este ambiente emite comprobantes de prueba sin validez fiscal."
