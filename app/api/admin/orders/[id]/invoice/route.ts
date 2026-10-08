import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  arcaConfigurationErrorResponse,
  requireArcaConfiguration,
  type ArcaConfiguration,
} from "@/lib/arca/configuration"
import { ArcaConfigurationError } from "@/lib/arca/environment"
import { buildFiscalArcaQrUrl } from "@/lib/arca/qr"
import { processArcaInvoice } from "@/lib/arca/invoice-automation"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"

export const runtime = "nodejs"

/**
 * Emisión / reintento MANUAL desde Admin. Usa exactamente el mismo servicio
 * idempotente que el worker automático (claim + número persistido antes de
 * pedir CAE + reconciliación): un doble click, un reintento o el worker
 * corriendo en paralelo nunca generan una segunda Factura C. Qué pedido es
 * facturable lo decide la base (order_is_invoiceable), no esta ruta.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Orden inválida." }, { status: 400 })
  }

  // Guard central: sin configuración ARCA válida no se toma el pedido ni se
  // contacta a ARCA.
  let configuration: ArcaConfiguration
  try {
    configuration = requireArcaConfiguration()
  } catch (error) {
    if (error instanceof ArcaConfigurationError) return arcaConfigurationErrorResponse(error)
    throw error
  }

  const result = await processArcaInvoice(auth.admin, {
    gateway: createWsfeInvoiceGateway(configuration),
    pointOfSale: configuration.pointOfSale,
    orderId,
    manual: true,
  })

  switch (result.status) {
    case "authorized": {
      const { invoice } = result
      return NextResponse.json({
        invoice: {
          invoice_number: invoice.voucherNumber,
          invoice_point: invoice.pointOfSale,
          invoice_cae: invoice.cae,
          invoice_cae_due: invoice.caeDue,
          invoice_status: "authorized",
          invoice_arca_environment: invoice.environment,
          voucher_type: invoice.voucherType,
          issue_date: invoice.issueDate,
          total: invoice.total,
          reconciled: invoice.reconciled,
          // null en homologación: un comprobante de prueba no tiene QR fiscal.
          qr_url: buildFiscalArcaQrUrl({
            environment: invoice.environment,
            issueDate: invoice.issueDate,
            cuit: configuration.cuit,
            pointOfSale: invoice.pointOfSale,
            voucherType: invoice.voucherType,
            voucherNumber: invoice.voucherNumber,
            total: invoice.total,
            cae: invoice.cae,
          }),
        },
      })
    }
    case "already_authorized":
      return NextResponse.json({ error: "La orden ya está facturada." }, { status: 409 })
    case "not_invoiceable":
      return NextResponse.json(
        {
          error:
            "El pedido no es facturable: el pago no está confirmado, tiene un conflicto, una cancelación o un cambio pendiente.",
        },
        { status: 409 },
      )
    case "busy":
    case "idle":
      return NextResponse.json(
        { error: "Ya hay una factura en proceso. Esperá a que termine antes de reintentar." },
        { status: 409 },
      )
    case "failed":
      // El pago, el stock y el pedido NO se tocan: queda "Facturación
      // pendiente" con el motivo visible y reintento automático.
      return NextResponse.json(
        { error: "No se pudo completar la facturación. Revisá el estado antes de reintentar.", willRetry: result.willRetry },
        { status: 502 },
      )
  }
}
