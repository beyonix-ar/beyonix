import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  generateInvoicePdf,
  invoicePdfFilename,
  type InvoicePdfOrder,
} from "@/lib/arca/invoice-pdf"

export const runtime = "nodejs"

function optionalText(value: unknown) {
  if (typeof value !== "string") return null
  const text = value.trim()
  return text || null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Orden inválida." }, { status: 400 })
  }

  const { data: order, error: orderError } = await auth.admin
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

  const { data: itemRows, error: itemsError } = await auth.admin
    .from("orden_items")
    .select("*")
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
      ? auth.admin.from("productos").select("*").in("id", productIds)
      : Promise.resolve({ data: [], error: null }),
    variantIds.length
      ? auth.admin
          .from("producto_variantes")
          .select("*")
          .in("id", variantIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (productsResult.error || variantsResult.error) {
    console.error("ADMIN_INVOICE_PDF_CATALOG_ERROR", {
      orderId,
      step: "buscar productos y variantes",
      productsError: productsResult.error?.message,
      variantsError: variantsResult.error?.message,
    })
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
  let profile: Record<string, unknown> | null = null

  if (order.usuario_id) {
    const { data: profileData, error: profileError } = await auth.admin
      .from("profiles")
      .select("*")
      .eq("id", order.usuario_id)
      .maybeSingle()

    if (profileError) {
      console.error("ADMIN_INVOICE_PDF_PROFILE_ERROR", {
        orderId,
        step: "buscar perfil del cliente",
        message: profileError.message,
        code: profileError.code,
      })
    } else {
      profile = profileData as Record<string, unknown> | null
    }
  }

  const profileAddress = [
    optionalText(profile?.calle),
    optionalText(profile?.numero),
    optionalText(profile?.piso)
      ? `Piso ${optionalText(profile?.piso)}`
      : null,
    optionalText(profile?.departamento)
      ? `Dpto. ${optionalText(profile?.departamento)}`
      : null,
  ]
    .filter(Boolean)
    .join(" ")
  const orderRecord = order as Record<string, unknown>
  const invoiceOrder = {
    ...order,
    total: Number(order.total ?? 0),
    cliente_nombre:
      optionalText(order.cliente_nombre) ??
      optionalText(profile?.nombre) ??
      optionalText(profile?.username) ??
      "Consumidor final",
    cliente_email:
      optionalText(order.cliente_email) ??
      optionalText(profile?.email) ??
      "No informado",
    cliente_telefono:
      optionalText(order.cliente_telefono) ??
      optionalText(profile?.telefono) ??
      "No informado",
    cliente_direccion:
      optionalText(order.cliente_direccion) ??
      optionalText(profileAddress) ??
      "No informada",
    localidad:
      optionalText(order.localidad) ?? optionalText(profile?.localidad),
    provincia:
      optionalText(order.provincia) ?? optionalText(profile?.provincia),
    shipping_cost_charged:
      orderRecord.shipping_cost_charged ?? orderRecord.andreani_costo ?? 0,
    shipping_type: orderRecord.shipping_type ?? null,
    shipping_provider:
      orderRecord.shipping_provider ?? orderRecord.envio_proveedor ?? null,
    envio_proveedor: orderRecord.envio_proveedor ?? null,
    andreani_costo: orderRecord.andreani_costo ?? null,
    free_shipping_applied:
      orderRecord.free_shipping_applied === true,
    payment_method_id: orderRecord.payment_method_id ?? null,
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
