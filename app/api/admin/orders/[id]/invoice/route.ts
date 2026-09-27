import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { buildArcaQrUrl } from "@/lib/arca/qr"
import {
  getArcaPointOfSale,
  processArcaInvoice,
} from "@/lib/arca/invoice-automation"
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

  let pointOfSale: number
  try {
    pointOfSale = getArcaPointOfSale()
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ARCA_PTO_VTA inválido." },
      { status: 500 },
    )
  }

  const result = await processArcaInvoice(auth.admin, {
    gateway: createWsfeInvoiceGateway(),
    pointOfSale,
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
          voucher_type: invoice.voucherType,
          issue_date: invoice.issueDate,
          total: invoice.total,
          reconciled: invoice.reconciled,
          qr_url: buildArcaQrUrl({
            issueDate: invoice.issueDate,
            cuit: process.env.ARCA_CUIT ?? "",
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
        { error: result.error, willRetry: result.willRetry },
        { status: 502 },
      )
  }
}
