import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { getArcaConfigurationStatus } from "@/lib/arca/configuration"

export const runtime = "nodejs"

/**
 * Estado de la configuración ARCA para Admin. No contacta a ARCA y no expone
 * secretos: ni PEM, ni clave, ni passphrase, ni CUIT.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  return Response.json(
    { arca: getArcaConfigurationStatus() },
    { headers: { "Cache-Control": "no-store" } },
  )
}
