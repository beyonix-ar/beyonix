/**
 * Diagnóstico de conectividad ARCA SIN EMITIR: configuración -> FEDummy ->
 * WSAA -> FEParamGetPtosVenta -> FECompUltimoAutorizado (Factura C y NC C).
 *
 * Las dependencias no incluyen ninguna solicitud de CAE: este diagnóstico no
 * puede emitir un comprobante aunque se lo llame mal. Obtener el TA de WSAA no emite nada y
 * queda persistido para la emisión posterior (wsaa-ticket-cache).
 */

import type { ArcaConfiguration, ArcaConfigurationStatus } from "./configuration.ts"
import type { ArcaEnvironment } from "./environment.ts"

export const DIAGNOSTIC_FACTURA_C_TYPE = 11
export const DIAGNOSTIC_NOTA_CREDITO_C_TYPE = 13

export interface DiagnosticPointOfSale {
  number: number
  emissionType: string
  blocked: boolean
  droppedAt: string | null
}

export interface ArcaDiagnosticsDependencies {
  inspect(): { status: ArcaConfigurationStatus; configuration: ArcaConfiguration | null }
  dummy(): Promise<{ appServer: string; dbServer: string; authServer: string }>
  authenticate(configuration: ArcaConfiguration): Promise<{ expirationTime: string }>
  pointsOfSale(): Promise<DiagnosticPointOfSale[]>
  lastAuthorized(pointOfSale: number, voucherType: number): Promise<number>
  describeError(error: unknown): string
}

export type ArcaDiagnosticStepId =
  | "configuration"
  | "fedummy"
  | "wsaa"
  | "points_of_sale"
  | "last_invoice"
  | "last_credit_note"

export interface ArcaDiagnosticStep {
  id: ArcaDiagnosticStepId
  label: string
  ok: boolean
  detail: string
}

export interface ArcaDiagnosticsReport {
  ok: boolean
  environment: ArcaEnvironment | null
  pointOfSale: number | null
  /** Todo verificado y en producción: se puede emitir UNA Factura C manual. */
  readyForFirstFiscalInvoice: boolean
  nextInvoiceNumber: number | null
  steps: ArcaDiagnosticStep[]
}

export async function runArcaConnectivityDiagnostics(
  deps: ArcaDiagnosticsDependencies,
): Promise<ArcaDiagnosticsReport> {
  const steps: ArcaDiagnosticStep[] = []
  const { status, configuration } = deps.inspect()
  let nextNumber: number | null = null
  const report = (): ArcaDiagnosticsReport => {
    const ok = steps.length === 6 && steps.every((step) => step.ok)
    const lastInvoice = steps.find((step) => step.id === "last_invoice")
    return {
      ok,
      environment: status.environment,
      pointOfSale: status.pointOfSale,
      readyForFirstFiscalInvoice: ok && status.environment === "production",
      nextInvoiceNumber: lastInvoice?.ok ? nextNumber : null,
      steps,
    }
  }

  if (!configuration) {
    steps.push({ id: "configuration", label: "Configuración", ok: false, detail: status.errors.join(" ") })
    return report()
  }
  steps.push({
    id: "configuration",
    label: "Configuración",
    ok: true,
    detail: `${configuration.environment === "production" ? "Producción" : "Homologación"} · punto de venta ${configuration.pointOfSale} · certificado vigente hasta ${configuration.certificateExpiresAt.slice(0, 10)}.`,
  })

  const run = async (
    id: ArcaDiagnosticStepId,
    label: string,
    check: () => Promise<{ ok: boolean; detail: string }>,
  ) => {
    try {
      const result = await check()
      steps.push({ id, label, ...result })
      return result.ok
    } catch (error) {
      steps.push({ id, label, ok: false, detail: deps.describeError(error) })
      return false
    }
  }

  const proceed =
    (await run("fedummy", "FEDummy (disponibilidad WSFE)", async () => {
      const health = await deps.dummy()
      const ok = [health.appServer, health.dbServer, health.authServer].every((value) => value === "OK")
      return {
        ok,
        detail: `Aplicación ${health.appServer || "-"}, base ${health.dbServer || "-"}, autenticación ${health.authServer || "-"}.`,
      }
    })) &&
    (await run("wsaa", "WSAA (autenticación del certificado)", async () => {
      const ticket = await deps.authenticate(configuration)
      return { ok: true, detail: `Ticket de acceso vigente hasta ${ticket.expirationTime}.` }
    })) &&
    (await run("points_of_sale", "Punto de venta habilitado para Web Services", async () => {
      const points = await deps.pointsOfSale()
      const point = points.find((candidate) => candidate.number === configuration.pointOfSale)
      if (!point) {
        const available = points.map((candidate) => candidate.number).join(", ") || "ninguno"
        return {
          ok: false,
          detail: `ARCA no informa el punto de venta ${configuration.pointOfSale} para Web Services de este CUIT (informados: ${available}).`,
        }
      }
      if (point.blocked || point.droppedAt) {
        return {
          ok: false,
          detail: `El punto de venta ${point.number} está ${point.blocked ? "bloqueado" : `dado de baja (${point.droppedAt})`}.`,
        }
      }
      return { ok: true, detail: `Punto de venta ${point.number} activo · tipo de emisión: ${point.emissionType || "sin informar"}.` }
    })) &&
    (await run("last_invoice", "Última Factura C autorizada", async () => {
      const last = await deps.lastAuthorized(configuration.pointOfSale, DIAGNOSTIC_FACTURA_C_TYPE)
      nextNumber = last + 1
      return { ok: true, detail: `Última: ${last}. La próxima Factura C sería la ${nextNumber}.` }
    }))

  if (proceed) {
    await run("last_credit_note", "Última Nota de Crédito C autorizada", async () => {
      const last = await deps.lastAuthorized(configuration.pointOfSale, DIAGNOSTIC_NOTA_CREDITO_C_TYPE)
      return { ok: true, detail: `Última: ${last}.` }
    })
  }

  return report()
}
