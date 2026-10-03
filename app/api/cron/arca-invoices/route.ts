import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { arcaAutoInvoicingView, type ArcaAutoInvoicingControl } from "@/lib/arca/auto-invoicing-control"
import { getArcaConfigurationStatus, requireArcaConfiguration, type ArcaConfiguration } from "@/lib/arca/configuration"
import { ArcaConfigurationError } from "@/lib/arca/environment"
import { processArcaInvoiceQueue } from "@/lib/arca/invoice-automation"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"

/**
 * Worker de facturación automática: emite Factura C para las ventas que la
 * base encoló como facturables (pago confirmado + stock consumido). Idempotente
 * y serializado: correrlo dos veces a la vez nunca duplica un comprobante.
 *
 * Kill switch: sólo emite con ARCA_AUTO_INVOICING_ENABLED=true. Mientras esté
 * apagado, las ventas quedan en "Facturación pendiente" (nada se pierde) y
 * Admin puede emitirlas a mano con el mismo servicio.
 */
export async function GET(request: Request) {
  if (!isCronRequestAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  if (process.env.ARCA_AUTO_INVOICING_ENABLED?.trim().toLowerCase() !== "true") {
    return NextResponse.json({ ok: true, skipped: "ARCA_AUTO_INVOICING_ENABLED no está habilitado." })
  }

  // Mismo guard central que la emisión manual: sin configuración válida no
  // se toma ningún pedido de la cola ni se contacta a ARCA.
  let configuration: ArcaConfiguration
  try {
    configuration = requireArcaConfiguration()
  } catch (error) {
    if (!(error instanceof ArcaConfigurationError)) throw error
    console.error("ARCA_INVOICE_CRON_CONFIG_ERROR", { errors: error.errors })
    return NextResponse.json(
      { ok: false, error: "Configuración ARCA inválida.", errors: error.errors },
      { status: 503 },
    )
  }

  const admin = createAdminClient()
  const { data: control, error: controlError } = await admin
    .from("arca_auto_invoicing_control")
    .select("enabled, cutoff_at, updated_at")
    .eq("id", true)
    .single()
  if (controlError || !control) {
    return NextResponse.json({ ok: false, error: "Control automático ARCA no disponible." }, { status: 503 })
  }
  if (!arcaAutoInvoicingView(control as ArcaAutoInvoicingControl, getArcaConfigurationStatus()).enabled) {
    return NextResponse.json({ ok: true, skipped: "Facturación automática no activada en Admin." })
  }

  const summary = await processArcaInvoiceQueue(admin, {
    gateway: createWsfeInvoiceGateway(configuration),
    pointOfSale: configuration.pointOfSale,
  })

  return NextResponse.json({ ok: true, authorized: summary.authorized, failed: summary.failed })
}
