import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { arcaAutoInvoicingView, type ArcaAutoInvoicingControl } from "@/lib/arca/auto-invoicing-control"
import { getArcaConfigurationStatus, requireArcaConfiguration, type ArcaConfiguration } from "@/lib/arca/configuration"
import { ArcaConfigurationError } from "@/lib/arca/environment"
import { processArcaInvoiceQueue } from "@/lib/arca/invoice-automation"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"
import { runAutomaticCancellationBatch } from "@/lib/orders/automatic-cancellation"
import { createAdminClient } from "@/lib/supabase/admin"

export const runtime = "nodejs"

/**
 * Worker de facturación automática: emite Factura C para las ventas que la
 * base encoló como facturables (pago confirmado + stock consumido). Idempotente
 * y serializado: correrlo dos veces a la vez nunca duplica un comprobante.
 * Después procesa las cancelaciones facturadas (NC C y reintegro).
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
    // Nunca en silencio: ventas pagadas esperando Factura C con el automático
    // apagado quedan pendientes hasta que Admin las emita o active el control.
    const { count: pendingInvoices, error: pendingError } = await admin
      .from("ordenes")
      .select("id", { count: "exact", head: true })
      .in("invoice_status", ["pending", "error"])
      .is("invoice_cae", null)
    if (!pendingError && pendingInvoices) {
      console.warn("ARCA_AUTO_INVOICING_DISABLED_WITH_PENDING", { pendingInvoices })
    }
    return NextResponse.json({
      ok: true,
      skipped: "Facturación automática no activada en Admin.",
      pendingInvoices: pendingError ? null : pendingInvoices ?? 0,
    })
  }

  const gateway = createWsfeInvoiceGateway(configuration)
  const summary = await processArcaInvoiceQueue(admin, {
    gateway,
    pointOfSale: configuration.pointOfSale,
    limit: 50,
    deadlineMs: 45_000,
  })

  // Cancelaciones facturadas: NC C → reintegro, en la misma corrida y después
  // de facturar (una cancelación previa a la factura sigue sola apenas llega
  // el CAE). No depende de instalar otro timer: el de cancelaciones nunca se
  // instaló en producción y BX-1005 quedó sin NC. Ese timer puede convivir:
  // claim con lease + SKIP LOCKED, nunca dos workers sobre el mismo pedido.
  try {
    const cancellations = await runAutomaticCancellationBatch(admin, gateway, configuration.pointOfSale)
    return NextResponse.json({ ok: true, authorized: summary.authorized, failed: summary.failed, cancellations })
  } catch (cause) {
    console.error("AUTO_CANCELLATION_BATCH_ERROR", { message: cause instanceof Error ? cause.message : "UNEXPECTED_ERROR" })
    // 503: el timer queda en "failed" y se ve en journalctl; las facturas ya emitidas quedan firmes.
    return NextResponse.json({
      ok: false, authorized: summary.authorized, failed: summary.failed,
      error: "No se pudo procesar la cola de cancelaciones.",
    }, { status: 503 })
  }
}
