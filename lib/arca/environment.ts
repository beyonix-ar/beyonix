/**
 * Ambiente ARCA de un comprobante. Homologación y producción numeran por
 * separado: un comprobante sólo se identifica por ambiente + punto + tipo +
 * número (migración 20260927120000).
 */
export type ArcaEnvironment = "homologation" | "production"

/**
 * ÚNICA fuente del ambiente activo: endpoints WSAA/WSFE, clave del TA
 * persistido y ambiente guardado en cada comprobante salen de acá.
 * Producción sólo con ARCA_ENV=production explícito.
 */
export function getConfiguredArcaEnvironment(value = process.env.ARCA_ENV): ArcaEnvironment {
  return value?.trim().toLowerCase() === "production" ? "production" : "homologation"
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
