import "server-only"

import { requireArcaConfiguration, type ArcaConfiguration } from "@/lib/arca/configuration"
import type { ArcaInvoiceGateway } from "@/lib/arca/invoice-automation"
import {
  ArcaWsError,
  feCompConsultar,
  fecaeSolicitar,
  feCompUltimoAutorizado,
} from "@/lib/arca/wsfe"

/** Mismo texto que mostraba la emisión manual: código y mensaje de ARCA. */
export function describeArcaError(error: unknown) {
  if (error instanceof ArcaWsError && error.details.length) {
    const details = error.details.map((detail) => `${detail.Code}: ${detail.Msg}`).join(" | ")
    return `${error.message} ${details}`
  }
  return error instanceof Error ? error.message : "No se pudo emitir la Factura C."
}

/**
 * Único gateway de emisión (Factura C, NC y conciliaciones). Sin una
 * configuración ARCA válida lanza ArcaConfigurationError antes de existir:
 * ningún camino puede emitir con ARCA_ENV ausente ni con un certificado que
 * no corresponde al ambiente.
 */
export function createWsfeInvoiceGateway(
  configuration: ArcaConfiguration = requireArcaConfiguration(),
): ArcaInvoiceGateway {
  return {
    // Mismo ambiente con el que wsaa.ts/wsfe.ts eligen los endpoints.
    environment: configuration.environment,
    lastAuthorized: (pointOfSale, voucherType) => feCompUltimoAutorizado(pointOfSale, voucherType),
    consult: (pointOfSale, voucherNumber, voucherType) =>
      feCompConsultar(pointOfSale, voucherNumber, voucherType),
    requestCae: (request) => fecaeSolicitar(request),
    isDefinitiveRejection: (error) => error instanceof ArcaWsError && error.definitiveRejection,
    describeError: describeArcaError,
  }
}
