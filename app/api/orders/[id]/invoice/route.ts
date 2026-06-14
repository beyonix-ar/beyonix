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
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const orderId = Number(id)

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
    shipping_cost_charged:
      orderRecord.shipping_cost_charged ?? orderRecord.andreani_costo ?? 0,
    shipping_provider:
      orderRecord.shipping_provider ?? orderRecord.envio_proveedor ?? null,
    free_shipping_applied:
      orderRecord.free_shipping_applied === true,
    transfer_discount_amount:
      orderRecord.transfer_discount_amount ?? 0,
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
