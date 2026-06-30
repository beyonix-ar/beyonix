import { NextResponse } from "next/server"

import {
  generateInvoicePdf,
  invoicePdfFilename,
  type InvoicePdfOrder,
} from "@/lib/arca/invoice-pdf"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const orderId = Number(id)
  const url = new URL(request.url)
  const documentType =
    url.searchParams.get("type") === "credit_note" ? "credit_note" : "invoice"
  const isCreditNote = documentType === "credit_note"

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Orden inválida." }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("*")
    .eq("id", orderId)
    .eq("usuario_id", user.id)
    .maybeSingle()

  if (orderError) {
    console.error("CLIENT_INVOICE_PDF_ORDER_ERROR", {
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
      { error: "Factura no encontrada o sin autorización de acceso." },
      { status: 404 },
    )
  }

  if (
    isCreditNote &&
    (order.credit_note_status !== "authorized" ||
      order.credit_note_number == null ||
      order.credit_note_point == null ||
      !order.credit_note_cae ||
      !order.credit_note_cae_due ||
      !order.credit_note_created_at ||
      Number(order.credit_note_amount ?? 0) <= 0)
  ) {
    return NextResponse.json(
      { error: "La nota de crédito autorizada tiene datos incompletos." },
      { status: 409 },
    )
  }

  const { data: itemRows, error: itemsError } = await admin
    .from("orden_items")
    .select("*")
    .eq("orden_id", orderId)

  if (itemsError) {
    console.error("CLIENT_INVOICE_PDF_ITEMS_ERROR", {
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

  const items = itemRows ?? []
  const productIds = [...new Set(items.map((item) => item.producto_id))]
  const variantIds = [
    ...new Set(
      items
        .map((item) => item.variante_id)
        .filter((id): id is number => typeof id === "number"),
    ),
  ]
  const [productsResult, variantsResult] = await Promise.all([
    productIds.length
      ? admin.from("productos").select("*").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? admin.from("producto_variantes").select("*").in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (productsResult.error || variantsResult.error) {
    return NextResponse.json(
      { error: "No se pudieron recuperar los productos de la factura." },
      { status: 500 },
    )
  }

  const productsById = new Map(
    (productsResult.data ?? []).map((product) => [product.id, product]),
  )
  const variantsById = new Map(
    (variantsResult.data ?? []).map((variant) => [variant.id, variant]),
  )
  const orderRecord = order as Record<string, unknown>
  const invoiceOrder = {
    ...order,
    total: isCreditNote
      ? Number(order.credit_note_amount ?? 0)
      : Number(order.total ?? 0),
    shipping_cost_charged:
      orderRecord.shipping_cost_charged ?? orderRecord.andreani_costo ?? 0,
    shipping_provider:
      orderRecord.shipping_provider ?? orderRecord.envio_proveedor ?? null,
    free_shipping_applied:
      orderRecord.free_shipping_applied === true,
    transfer_discount_amount:
      orderRecord.transfer_discount_amount ?? 0,
    invoice_number: isCreditNote
      ? Number(order.credit_note_number)
      : Number(order.invoice_number),
    invoice_point: isCreditNote
      ? Number(order.credit_note_point)
      : Number(order.invoice_point),
    invoice_cae: isCreditNote
      ? String(order.credit_note_cae)
      : String(order.invoice_cae),
    invoice_cae_due: isCreditNote
      ? String(order.credit_note_cae_due)
      : String(order.invoice_cae_due),
    invoice_created_at: isCreditNote
      ? String(order.credit_note_created_at)
      : String(order.invoice_created_at),
    voucher_type: isCreditNote ? 13 : 11,
    document_title: isCreditNote ? "NOTA DE CRÉDITO" : "FACTURA",
    detail_title: isCreditNote
      ? "DETALLE DE NOTA DE CRÉDITO"
      : "DETALLE DE FACTURA",
    filename_prefix: isCreditNote ? "Nota-Credito" : "Factura",
    original_invoice_total: isCreditNote ? Number(order.total ?? 0) : null,
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
    orden_items: items.map((item) => ({
      cantidad: Number(item.cantidad ?? 0),
      precio: Number(item.precio ?? item.precio_unitario ?? 0),
      productos: productsById.get(item.producto_id) ?? null,
      producto_variantes:
        typeof item.variante_id === "number"
          ? variantsById.get(item.variante_id) ?? null
          : null,
    })),
  } as InvoicePdfOrder
  const pdf = await generateInvoicePdf(invoiceOrder)

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoicePdfFilename(invoiceOrder)}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
