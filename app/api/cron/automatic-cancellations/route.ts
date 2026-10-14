import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { arcaAutoInvoicingView, type ArcaAutoInvoicingControl } from "@/lib/arca/auto-invoicing-control"
import { getArcaConfigurationStatus, requireArcaConfiguration } from "@/lib/arca/configuration"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"
import { runAutomaticCancellationBatch } from "@/lib/orders/automatic-cancellation"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"

export async function GET(request: Request) {
  if (!isCronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return Response.json({ error: "No autorizado." }, { status: 401 })
  }
  // Mismo corte que el worker de Facturas. No se emite ninguna NC ni se mueve
  // dinero mientras la primera Factura C real y el control sigan pendientes.
  if (process.env.ARCA_AUTO_INVOICING_ENABLED?.trim().toLowerCase() !== "true") {
    return Response.json({ ok: true, skipped: "Facturación automática desactivada." })
  }
  const admin = createAdminClient()
  const { data: control, error } = await admin.from("arca_auto_invoicing_control")
    .select("enabled,cutoff_at,updated_at").eq("id", true).single()
  if (error || !control || !arcaAutoInvoicingView(control as ArcaAutoInvoicingControl, getArcaConfigurationStatus()).enabled) {
    return Response.json({ ok: true, skipped: "Control automático ARCA desactivado." })
  }
  try {
    const configuration = requireArcaConfiguration()
    const summary = await runAutomaticCancellationBatch(admin, createWsfeInvoiceGateway(configuration), configuration.pointOfSale)
    return Response.json({ ok: true, ...summary })
  } catch (cause) {
    console.error("AUTO_CANCELLATION_BATCH_ERROR", { message: cause instanceof Error ? cause.message : "UNEXPECTED_ERROR" })
    return Response.json({ ok: false, error: "No se pudo procesar la cola de cancelaciones." }, { status: 503 })
  }
}
