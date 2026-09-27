/**
 * Reemplaza @/lib/arca/wsfe-invoice-gateway SÓLO dentro del arnés. Usa el
 * gateway REAL (WSAA/WSFE de homologación) y agrega:
 *   - negativa a operar fuera de homologación (defensa en profundidad);
 *   - conciliaciones: prohíbe pedir CAE;
 *   - prueba de respuesta perdida: ARCA autoriza de verdad y la respuesta se
 *     descarta, como un timeout después de autorizar.
 */

import type { ArcaInvoiceGateway } from "../../../lib/arca/invoice-automation.ts"
import {
  createWsfeInvoiceGateway as createRealGateway,
  describeArcaError,
} from "../../../lib/arca/wsfe-invoice-gateway.ts"
import { harnessState } from "../harness-state.ts"

export { describeArcaError }

export function createWsfeInvoiceGateway(): ArcaInvoiceGateway {
  const real = createRealGateway()
  if (real.environment !== "homologation") {
    throw new Error("Arnés ARCA: el gateway no está en homologación. Operación abortada.")
  }
  return {
    ...real,
    async requestCae(request) {
      const state = harnessState()
      if (state.forbidCae) {
        throw new Error("Arnés ARCA: esta operación no puede pedir CAE. Abortada antes de contactar a ARCA.")
      }
      state.caeRequests += 1
      const result = await real.requestCae(request)
      if (state.loseNextCaeResponse) {
        state.loseNextCaeResponse = false
        state.lostResponses.push({
          voucherType: request.voucherType,
          voucherNumber: result.voucherNumber,
          cae: result.cae,
        })
        // Igual que un timeout: resultado desconocido, NO rechazo definitivo.
        throw new Error("Respuesta de ARCA descartada a propósito por el arnés (prueba de respuesta perdida).")
      }
      return result
    },
  }
}
