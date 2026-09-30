import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { inspectArcaConfiguration } from "@/lib/arca/configuration"
import { runArcaConnectivityDiagnostics } from "@/lib/arca/production-diagnostics"
import { getWsaaCredentials } from "@/lib/arca/wsaa"
import { feCompUltimoAutorizado, feParamGetPtosVenta, getWsfeHealth } from "@/lib/arca/wsfe"
import { describeArcaError } from "@/lib/arca/wsfe-invoice-gateway"

export const runtime = "nodejs"

/**
 * Diagnóstico previo a emitir (WSAA, FEDummy, puntos de venta y último
 * comprobante autorizado) con la configuración ARCA del servidor. Consulta
 * ARCA pero NUNCA pide un CAE: no emite comprobantes.
 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const report = await runArcaConnectivityDiagnostics({
    inspect: () => inspectArcaConfiguration(),
    dummy: () => getWsfeHealth(),
    authenticate: (configuration) => getWsaaCredentials(configuration),
    pointsOfSale: () => feParamGetPtosVenta(),
    lastAuthorized: (pointOfSale, voucherType) => feCompUltimoAutorizado(pointOfSale, voucherType),
    describeError: describeArcaError,
  })

  return Response.json({ diagnostics: report }, { headers: { "Cache-Control": "no-store" } })
}
