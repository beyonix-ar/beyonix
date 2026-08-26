import { NextResponse } from "next/server"

import {
  generateInvoicePdf,
  invoicePdfFilename,
  type InvoicePdfOrder,
} from "@/lib/arca/invoice-pdf"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

type CreditNotePdfRecord = {
  total_amount: number | string
  manual_amount: number | string
  voucher_number: number
  voucher_point: number
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

function escapeIlikeValue(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

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
  const byUserId = await admin
    .from("ordenes")
    .select("*")
    .eq("id", orderId)
    .eq("usuario_id", user.id)
    .maybeSingle()

  let order = byUserId.data
  let orderError = byUserId.error
  const normalizedEmail = user.email?.trim().toLowerCase()

  if (!order && !orderError && normalizedEmail) {
    const byLegacyEmail = await admin
      .from("ordenes")
      .select("*")
      .eq("id", orderId)
      .is("usuario_id", null)
      .ilike("cliente_email", escapeIlikeValue(normalizedEmail))
      .maybeSingle()
    order = byLegacyEmail.data
    orderError = byLegacyEmail.error
  }

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
    !order.invoice_number ||
    !order.invoice_point ||
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

  if (isCreditNote) {
    const requestedNoteId = url.searchParams.get("note")
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
    isCreditNote &&
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
    .select("id, orden_id, producto_id, variante_id, conditioned_name, cantidad, precio")
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
      ? admin.from("productos").select("id, nombre").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? admin.from("producto_variantes").select("id, nombre").in("id", variantIds)
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
  const creditNotePdfItems = creditNoteRecord
    ? [
        ...(creditNoteRecord.order_credit_note_items ?? []).map((item) => ({
          cantidad: Number(item.quantity),
          precio: Number(item.total_amount) / Number(item.quantity),
          productos: { nombre: item.product_name },
          producto_variantes: item.variant_name
            ? { nombre: item.variant_name }
            : null,
        })),
        ...(Number(creditNoteRecord.manual_amount ?? 0) > 0
          ? [{
              cantidad: 1,
              precio: Number(creditNoteRecord.manual_amount),
              productos: { nombre: `Ajuste: ${creditNoteRecord.reason}` },
              producto_variantes: null,
            }]
          : []),
      ]
    : []
  const invoiceOrder = {
    ...order,
    total: isCreditNote
      ? Number(creditNoteRecord?.total_amount ?? 0)
      : Number(order.total ?? 0),
    cliente_dni:
      typeof order.cliente_dni === "string" && order.cliente_dni.trim()
        ? order.cliente_dni.trim()
        : "No informado",
    shipping_cost_charged:
      isCreditNote
        ? 0
        : orderRecord.shipping_cost_charged ?? orderRecord.andreani_costo ?? 0,
    shipping_provider:
      orderRecord.shipping_provider ?? orderRecord.envio_proveedor ?? null,
    free_shipping_applied:
      orderRecord.free_shipping_applied === true,
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
    orden_items: isCreditNote ? creditNotePdfItems : items.map((item) => ({
      cantidad: Number(item.cantidad ?? 0),
      precio: Number(item.precio ?? 0),
      productos: productsById.get(item.producto_id) ?? null,
      producto_variantes:
        typeof item.conditioned_name === "string" &&
        item.conditioned_name.trim()
          ? { nombre: item.conditioned_name }
          : typeof item.variante_id === "number"
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
