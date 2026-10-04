import { NextResponse } from "next/server"

import type { AdminApiAuth } from "@/lib/auth/admin-api"
import {
  generateInvoicePdf,
  invoicePdfFilename,
  type InvoicePdfOrder,
} from "@/lib/arca/invoice-pdf"
import { loadFiscalInvoiceTotal, loadFiscalPdfItems } from "@/lib/arca/invoice-pdf-data"

type CreditNotePdfRecord = {
  id: string
  total_amount: number | string
  manual_amount: number | string
  original_shipping_refunded?: number | string
  other_adjustment_amount?: number | string
  voucher_number: number
  voucher_point: number
  arca_environment: string | null
  cae: string
  cae_due: string
  authorized_at: string
  reason: string
  order_credit_note_items?: Array<{
    quantity: number
    total_amount: number | string
    product_name: string
    variant_name?: string | null
  }>
}

export async function renderAdminInvoicePdf(
  admin: AdminApiAuth["admin"],
  orderId: number,
  documentType: "invoice" | "credit_note",
  requestedNoteId: string | null = null,
) {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Orden inválida." }, { status: 400 })
  }

  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("*")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError) {
    console.error("ADMIN_INVOICE_PDF_ORDER_ERROR", {
      orderId,
      step: "buscar orden",
      message: orderError.message,
      code: orderError.code,
    })
    return NextResponse.json(
      { error: "No se pudieron recuperar los datos de la factura." },
      { status: 500 },
    )
  }

  if (!order || order.invoice_status !== "authorized") {
    return NextResponse.json(
      { error: "La factura no está disponible." },
      { status: 404 },
    )
  }

  if (
    order.invoice_number == null ||
    order.invoice_point == null ||
    !order.invoice_cae ||
    !order.invoice_cae_due ||
    !order.invoice_created_at
  ) {
    return NextResponse.json(
      { error: "La factura autorizada tiene datos incompletos." },
      { status: 409 },
    )
  }

  let creditNoteRecord: CreditNotePdfRecord | null = null

  if (documentType === "credit_note") {
    let noteQuery = admin
      .from("order_credit_notes")
      .select("*, order_credit_note_items(*)")
      .eq("order_id", orderId)
      .eq("status", "authorized")

    noteQuery = requestedNoteId
      ? noteQuery.eq("id", requestedNoteId)
      : noteQuery.order("authorized_at", { ascending: false }).limit(1)

    const { data: noteRows, error: noteError } = await noteQuery
    if (noteError) {
      return NextResponse.json(
        { error: "No se pudo recuperar la nota de crédito autorizada." },
        { status: 500 },
      )
    }
    creditNoteRecord = (noteRows?.[0] ?? null) as CreditNotePdfRecord | null
  }

  if (
    documentType === "credit_note" &&
    (!creditNoteRecord ||
      !creditNoteRecord.voucher_number ||
      !creditNoteRecord.voucher_point ||
      !creditNoteRecord.cae ||
      !creditNoteRecord.cae_due ||
      !creditNoteRecord.authorized_at ||
      Number(creditNoteRecord.total_amount ?? 0) <= 0)
  ) {
    return NextResponse.json(
      { error: "La nota de crédito autorizada tiene datos incompletos." },
      { status: 409 },
    )
  }

  const { data: itemRows, error: itemsError } = await admin
    .from("orden_items")
    .select("id, producto_id, variante_id, conditioned_name, cantidad, precio")
    .eq("orden_id", orderId)

  if (itemsError) {
    console.error("ADMIN_INVOICE_PDF_ITEMS_ERROR", {
      orderId,
      step: "buscar ítems",
      message: itemsError.message,
      code: itemsError.code,
    })
    return NextResponse.json(
      { error: "No se pudo recuperar el detalle de la factura." },
      { status: 500 },
    )
  }

  let fiscalItems
  let originalFiscalTotal: number
  try {
    const [items, total] = await Promise.all([
      documentType === "invoice" ? loadFiscalPdfItems(admin, orderId, itemRows ?? []) : Promise.resolve([]),
      loadFiscalInvoiceTotal(admin, orderId, order),
    ])
    fiscalItems = items
    originalFiscalTotal = total
  } catch (error) {
    console.error("ADMIN_INVOICE_PDF_DETAIL_ERROR", { orderId, message: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: "No se pudo recuperar el detalle de la factura." }, { status: 500 })
  }
  const orderRecord = order as Record<string, unknown>
  const isCreditNote = documentType === "credit_note"
  const creditNotePdfItems = creditNoteRecord
    ? [
        ...(creditNoteRecord.order_credit_note_items ?? []).map((item) => ({
          cantidad: Number(item.quantity),
          precio:
            Number(item.quantity) > 0
              ? Number(item.total_amount) / Number(item.quantity)
              : 0,
          productos: { nombre: item.product_name },
          producto_variantes: item.variant_name
            ? { nombre: item.variant_name }
            : null,
        })),
        {
          cantidad: 1,
          precio: Number(creditNoteRecord.original_shipping_refunded ?? 0),
          productos: {
            nombre: "Envío reintegrado",
          },
          producto_variantes: null,
        },
        ...(Number(creditNoteRecord.other_adjustment_amount ?? 0) > 0
          ? [
              {
                cantidad: 1,
                precio: Number(creditNoteRecord.other_adjustment_amount),
                productos: {
                  nombre: `Otros ajustes: ${creditNoteRecord.reason}`,
                },
                producto_variantes: null,
              },
            ]
          : []),
      ]
    : []
  const invoiceOrder = {
    ...order,
    total: isCreditNote
      ? Number(creditNoteRecord?.total_amount ?? 0)
      : originalFiscalTotal,
    cliente_dni:
      typeof order.cliente_dni === "string" && order.cliente_dni.trim()
        ? order.cliente_dni.trim()
        : "No informado",
    shipping_cost_charged:
      isCreditNote
        ? 0
        : orderRecord.shipping_cost_charged ?? orderRecord.andreani_costo ?? 0,
    shipping_type: orderRecord.shipping_type ?? null,
    shipping_provider:
      orderRecord.shipping_provider ?? orderRecord.envio_proveedor ?? null,
    envio_proveedor: orderRecord.envio_proveedor ?? null,
    andreani_costo: orderRecord.andreani_costo ?? null,
    free_shipping_applied:
      orderRecord.free_shipping_applied === true,
    payment_method_id: orderRecord.payment_method_id ?? null,
    transfer_discount_amount:
      isCreditNote ? 0 : orderRecord.transfer_discount_amount ?? 0,
    invoice_number: isCreditNote
      ? Number(creditNoteRecord?.voucher_number)
      : Number(order.invoice_number),
    invoice_point: isCreditNote
      ? Number(creditNoteRecord?.voucher_point)
      : Number(order.invoice_point),
    invoice_cae: isCreditNote
      ? String(creditNoteRecord?.cae)
      : String(order.invoice_cae),
    invoice_cae_due: isCreditNote
      ? String(creditNoteRecord?.cae_due)
      : String(order.invoice_cae_due),
    invoice_created_at: isCreditNote
      ? String(creditNoteRecord?.authorized_at)
      : String(order.invoice_created_at),
    arca_environment: isCreditNote
      ? creditNoteRecord?.arca_environment ?? null
      : order.invoice_arca_environment ?? null,
    voucher_type: isCreditNote ? 13 : 11,
    document_title: isCreditNote ? "NOTA DE CRÉDITO" : "FACTURA",
    detail_title: isCreditNote
      ? "DETALLE DE NOTA DE CRÉDITO"
      : "DETALLE DE FACTURA",
    filename_prefix: isCreditNote ? "Nota-Credito" : "Factura",
    original_invoice_total: isCreditNote ? originalFiscalTotal : null,
    original_invoice_created_at: isCreditNote
      ? String(order.invoice_created_at)
      : null,
    original_invoice_cae: isCreditNote ? String(order.invoice_cae) : null,
    credit_note_for_invoice: isCreditNote
      ? {
          point: Number(order.invoice_point),
          number: Number(order.invoice_number),
        }
      : undefined,
    orden_items: isCreditNote ? creditNotePdfItems : fiscalItems,
  } as InvoicePdfOrder

  let pdf: Uint8Array
  try {
    pdf = await generateInvoicePdf(invoiceOrder)
  } catch (error) {
    console.error("ADMIN_INVOICE_PDF_GENERATION_ERROR", {
      orderId,
      step: "generar PDF",
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json(
      { error: "No se pudo generar el PDF de la factura." },
      { status: 500 },
    )
  }

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoicePdfFilename(invoiceOrder)}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
