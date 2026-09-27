import "server-only"

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

export function createWsfeInvoiceGateway(): ArcaInvoiceGateway {
  return {
    lastAuthorized: (pointOfSale, voucherType) => feCompUltimoAutorizado(pointOfSale, voucherType),
    consult: (pointOfSale, voucherNumber, voucherType) =>
      feCompConsultar(pointOfSale, voucherNumber, voucherType),
    requestCae: (request) => fecaeSolicitar(request),
    isDefinitiveRejection: (error) => error instanceof ArcaWsError && error.definitiveRejection,
    describeError: describeArcaError,
  }
}
