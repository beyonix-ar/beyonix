import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { buildArcaQrUrl } from "@/lib/arca/qr"
import {
  ArcaWsError,
  FACTURA_C_TYPE,
  fecaeSolicitar,
  feCompUltimoAutorizado,
} from "@/lib/arca/wsfe"

export const runtime = "nodejs"

function getPointOfSale() {
  const pointOfSale = Number(process.env.ARCA_PTO_VTA)
  if (!Number.isInteger(pointOfSale) || pointOfSale <= 0) {
    throw new Error("ARCA_PTO_VTA debe ser un entero mayor que cero.")
  }

  return pointOfSale
}

function argentinaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    arca: `${value.year}${value.month}${value.day}`,
    iso: `${value.year}-${value.month}-${value.day}`,
  }
}

function arcaDateToIso(value: string) {
  if (!/^\d{8}$/.test(value)) {
    throw new Error("ARCA devolvió una fecha de vencimiento de CAE inválida.")
  }

  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function invoiceErrorMessage(error: unknown) {
  if (error instanceof ArcaWsError && error.details.length) {
    const details = error.details
      .map((detail) => `${detail.Code}: ${detail.Msg}`)
      .join(" | ")
    return `${error.message} ${details}`
  }

  return error instanceof Error
    ? error.message
    : "No se pudo emitir la Factura C."
}

export async function POST(
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
    .select(
      "id, total, estado, payment_status, invoice_number, invoice_point, invoice_cae, invoice_cae_due, invoice_status, invoice_created_at",
    )
    .eq("id", orderId)
    .single()

  if (orderError || !order) {
    return NextResponse.json({ error: "Orden no encontrada." }, { status: 404 })
  }

  if (order.invoice_status === "authorized" && order.invoice_cae) {
    return NextResponse.json({ error: "La orden ya está facturada." }, { status: 409 })
  }

  if (!["approved", "confirmado"].includes(order.payment_status ?? "")) {
    return NextResponse.json(
      { error: "La orden no tiene un pago confirmado." },
      { status: 400 },
    )
  }

  const total = Number(order.total)
  if (!Number.isFinite(total) || total <= 0) {
    return NextResponse.json(
      { error: "La orden tiene un total inválido." },
      { status: 400 },
    )
  }

  const { data: lockedOrder, error: lockError } = await auth.admin
    .from("ordenes")
    .update({ invoice_status: "processing" })
    .eq("id", orderId)
    .or("invoice_status.is.null,invoice_status.eq.error")
    .select("id")
    .maybeSingle()

  if (lockError) {
    return NextResponse.json(
      { error: "No se pudo iniciar la facturación." },
      { status: 500 },
    )
  }

  if (!lockedOrder) {
    return NextResponse.json(
      { error: "La factura ya se está procesando." },
      { status: 409 },
    )
  }

  try {
    const pointOfSale = getPointOfSale()
    const lastVoucher = await feCompUltimoAutorizado(
      pointOfSale,
      FACTURA_C_TYPE,
    )
    const voucherNumber = lastVoucher + 1
    const issueDate = argentinaDate()
    const authorization = await fecaeSolicitar({
      pointOfSale,
      voucherNumber,
      voucherDate: issueDate.arca,
      total,
    })
    const createdAt = new Date().toISOString()
    const invoice = {
      invoice_number: authorization.voucherNumber,
      invoice_point: pointOfSale,
      invoice_cae: authorization.cae,
      invoice_cae_due: arcaDateToIso(authorization.caeDueDate),
      invoice_status: "authorized",
      invoice_created_at: createdAt,
    }
    const { data: updatedOrder, error: updateError } = await auth.admin
      .from("ordenes")
      .update(invoice)
      .eq("id", orderId)
      .eq("invoice_status", "processing")
      .select()
      .single()

    if (updateError || !updatedOrder) {
      throw new Error(
        "ARCA autorizó la factura, pero no se pudo guardar en la orden.",
      )
    }

    return NextResponse.json({
      invoice: {
        ...invoice,
        voucher_type: FACTURA_C_TYPE,
        issue_date: issueDate.iso,
        total: Number(total.toFixed(2)),
        qr_url: buildArcaQrUrl({
          issueDate: issueDate.iso,
          cuit: process.env.ARCA_CUIT ?? "",
          pointOfSale,
          voucherType: FACTURA_C_TYPE,
          voucherNumber: authorization.voucherNumber,
          total,
          cae: authorization.cae,
        }),
        observations: authorization.observations,
      },
    })
  } catch (error) {
    await auth.admin
      .from("ordenes")
      .update({ invoice_status: "error" })
      .eq("id", orderId)
      .eq("invoice_status", "processing")

    console.error("Error al emitir Factura C", {
      orderId,
      error: invoiceErrorMessage(error),
    })

    return NextResponse.json(
      { error: invoiceErrorMessage(error) },
      { status: error instanceof ArcaWsError ? 502 : 500 },
    )
  }
}
