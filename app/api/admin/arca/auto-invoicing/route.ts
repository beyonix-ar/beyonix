import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { arcaAutoInvoicingView, type ArcaAutoInvoicingControl } from "@/lib/arca/auto-invoicing-control"
import { getArcaConfigurationStatus } from "@/lib/arca/configuration"

export const runtime = "nodejs"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("arca_auto_invoicing_control")
    .select("enabled, cutoff_at, updated_at")
    .eq("id", true)
    .single()
  if (error || !data) {
    return Response.json({ error: "No se pudo consultar el control automático ARCA." }, { status: 503, headers: NO_STORE })
  }

  return Response.json(
    { autoInvoicing: arcaAutoInvoicingView(data as ArcaAutoInvoicingControl, getArcaConfigurationStatus()) },
    { headers: NO_STORE },
  )
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Solicitud inválida." }, { status: 400, headers: NO_STORE })
  }
  if (!body || typeof body !== "object" || !("enabled" in body) || typeof body.enabled !== "boolean") {
    return Response.json({ error: "Estado automático inválido." }, { status: 400, headers: NO_STORE })
  }

  const configuration = getArcaConfigurationStatus()
  if (body.enabled && !configuration.configured) {
    return Response.json({ error: "Configuración ARCA inválida." }, { status: 503, headers: NO_STORE })
  }
  if (body.enabled && (configuration.environment !== "production" || !configuration.autoInvoicingEnabled)) {
    return Response.json(
      { error: "La activación requiere ARCA PROD y ARCA_AUTO_INVOICING_ENABLED=true en el servidor." },
      { status: 409, headers: NO_STORE },
    )
  }

  const { data, error } = await auth.admin.rpc("set_arca_auto_invoicing", {
    p_enabled: body.enabled,
    p_actor: auth.user.id,
  })
  if (error || !data) {
    const firstManualRequired = error?.message.includes("ARCA_FIRST_MANUAL_INVOICE_REQUIRED")
    return Response.json(
      { error: firstManualRequired
        ? "Primero emití y verificá una Factura C real de forma manual."
        : "No se pudo actualizar el control automático ARCA." },
      { status: firstManualRequired ? 409 : 503, headers: NO_STORE },
    )
  }

  return Response.json(
    { autoInvoicing: arcaAutoInvoicingView(data as ArcaAutoInvoicingControl, configuration) },
    { headers: NO_STORE },
  )
}
