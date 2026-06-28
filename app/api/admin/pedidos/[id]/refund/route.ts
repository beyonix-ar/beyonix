import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import {
  PAYMENT_PROOF_BUCKET,
  getPaymentProofValidationError,
  sanitizePaymentProofFileName,
} from "@/lib/payments/transfer"

function stripBucket(path: string) {
  return path.startsWith(`${PAYMENT_PROOF_BUCKET}/`)
    ? path.slice(PAYMENT_PROOF_BUCKET.length + 1)
    : path
}

function normalizeStoredPath(path: string) {
  return path.startsWith(`${PAYMENT_PROOF_BUCKET}/`)
    ? path
    : `${PAYMENT_PROOF_BUCKET}/${path}`
}

function isPaymentConfirmed(order: {
  payment_status?: string | null
  paid_at?: string | null
  estado?: string | null
}) {
  return (
    Boolean(order.paid_at) ||
    ["confirmado", "approved", "confirmed"].includes(order.payment_status ?? "") ||
    ["pagado", "enviado", "en_camino", "entregado"].includes(order.estado ?? "")
  )
}

function isRefundableOrder(order: {
  estado?: string | null
  financial_status?: string | null
  payment_status?: string | null
  paid_at?: string | null
}) {
  const status = order.financial_status ?? ""

  if (status === "refund_pending") return true
  if (status === "refunded" || status === "cancelled") return false

  return order.estado === "cancelado" && isPaymentConfirmed(order)
}

function isOrderInvoiced(order: {
  invoice_status?: string | null
  invoice_cae?: string | null
  invoice_number?: number | null
  invoice_point?: number | null
}) {
  return (
    order.invoice_status === "authorized" ||
    order.invoice_status === "processing" ||
    Boolean(order.invoice_cae) ||
    Boolean(order.invoice_number && order.invoice_point)
  )
}

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

function parseRefundAmount(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null

  const rawValue = String(value).trim()
  const normalized =
    rawValue.includes(",")
      ? rawValue.replace(/\./g, "").replace(",", ".")
      : rawValue.replace(/\.(?=\d{3}(?:\D|$))/g, "")
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getRefundAmountLimit(order: {
  payment_confirmed_amount?: number | string | null
  total?: number | string | null
}) {
  const confirmedAmount = Number(order.payment_confirmed_amount ?? 0)
  if (Number.isFinite(confirmedAmount) && confirmedAmount > 0) {
    return confirmedAmount
  }

  const total = Number(order.total ?? 0)
  return Number.isFinite(total) && total > 0 ? total : 0
}

async function createSignedRefundUrl(admin: any, path?: string | null) {
  if (!path) return null

  const { data } = await admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .createSignedUrl(stripBucket(path), 300)

  return data?.signedUrl ?? null
}

async function notifyCustomerRefunded(
  admin: any,
  order: {
    id: number
    usuario_id?: string | null
    cliente_email?: string | null
    cliente_nombre?: string | null
  },
) {
  const orderCode = getOrderCode(order.id)

  if (order.usuario_id) {
    const { error } = await admin.from("customer_notifications").upsert({
      user_id: order.usuario_id,
      type: "order_refunded",
      title: "Dinero reintegrado",
      body: `Registramos el reintegro correspondiente al pedido ${orderCode}.`,
      action_url: `/cuenta/compras/${order.id}`,
      order_id: order.id,
      source_key: `order:${order.id}:refunded`,
    }, { onConflict: "source_key" })

    if (error && error.code !== "23505") {
      console.log("No se pudo crear notificación de reintegro", error.message)
    }
  }

  await sendOrderStatusEmail({
    to: order.cliente_email,
    subject: `Reintegro registrado ${orderCode}`,
    html: `
      <h1>Dinero reintegrado</h1>
      <p>Hola ${order.cliente_nombre ?? ""}, registramos el reintegro correspondiente al pedido ${orderCode}.</p>
      <p>Podés ver el comprobante desde el detalle de tu compra.</p>
    `,
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const { data: order, error } = await auth.admin
    .from("ordenes")
    .select("id, refund_proof_url, refund_proof_file_name")
    .eq("id", orderId)
    .maybeSingle()

  if (error || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  const { data: proofs } = await auth.admin
    .from("order_refund_proofs")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })

  const signedUrl = await createSignedRefundUrl(auth.admin, order.refund_proof_url)
  const signedProofs = await Promise.all(
    (proofs ?? []).map(async (proof: any) => ({
      ...proof,
      signedUrl: await createSignedRefundUrl(auth.admin, proof.file_path),
    })),
  )

  return NextResponse.json({
    signedUrl,
    fileName: order.refund_proof_file_name,
    proofs: signedProofs,
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const formData = await request.formData()
  const file = formData.get("file")

  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Subí el comprobante de reintegro." },
      { status: 400 },
    )
  }

  const validationError = getPaymentProofValidationError(file)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }

  const { data: order, error: orderError } = await auth.admin
    .from("ordenes")
    .select("id, usuario_id, cliente_email, cliente_nombre, estado, total, payment_status, paid_at, payment_confirmed_amount, financial_status, invoice_status, invoice_cae, invoice_number, invoice_point, credit_note_required")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (!isRefundableOrder(order)) {
    return NextResponse.json(
      { error: "Sólo se puede reintegrar un pedido con reintegro pendiente." },
      { status: 409 },
    )
  }

  const amountLimit = getRefundAmountLimit(order)
  const amount = parseRefundAmount(formData.get("amount"))

  if (amount === null || amountLimit <= 0 || amount > amountLimit) {
    return NextResponse.json(
      {
        error:
          "Ingresá un monto de reintegro válido, mayor a cero y no superior al monto pagado.",
      },
      { status: 400 },
    )
  }

  const method = String(formData.get("method") ?? "").trim().slice(0, 120)

  if (!method) {
    return NextResponse.json(
      { error: "Indicá el método de reintegro." },
      { status: 400 },
    )
  }

  const observation =
    String(formData.get("observation") ?? "").trim().slice(0, 1000) || null
  const internalNote =
    String(formData.get("internalNote") ?? "").trim().slice(0, 1200) || null
  const safeName = sanitizePaymentProofFileName(file.name)
  const path = `refunds/${orderId}/${Date.now()}-${safeName}`

  const { error: uploadError } = await auth.admin.storage
    .from(PAYMENT_PROOF_BUCKET)
    .upload(path, file, {
      contentType: file.type,
      upsert: false,
    })

  if (uploadError) {
    return NextResponse.json(
      { error: uploadError.message || "No se pudo subir el comprobante." },
      { status: 500 },
    )
  }

  const storedPath = normalizeStoredPath(path)
  const now = new Date().toISOString()
  const creditNoteRequired =
    Boolean(order.credit_note_required) || isOrderInvoiced(order)
  const { data: proof, error: proofError } = await auth.admin
    .from("order_refund_proofs")
    .insert({
      order_id: orderId,
      uploaded_by: auth.user.id,
      file_name: file.name,
      file_path: storedPath,
      mime_type: file.type || "application/octet-stream",
      file_size: file.size,
      amount,
      method,
      observation,
    })
    .select()
    .single()

  if (proofError || !proof) {
    return NextResponse.json(
      { error: proofError?.message || "No se pudo guardar el comprobante." },
      { status: 500 },
    )
  }

  const { data: updatedOrder, error: updateError } = await auth.admin
    .from("ordenes")
    .update({
      financial_status: "refunded",
      refund_proof_url: storedPath,
      refund_proof_file_name: file.name,
      refund_proof_mime_type: file.type || "application/octet-stream",
      refund_proof_file_size: file.size,
      refund_amount: amount,
      refund_method: method,
      refund_observation: observation,
      refund_internal_note: internalNote,
      refund_uploaded_by: auth.user.id,
      refund_uploaded_at: now,
      refunded_at: now,
      refunded_by: auth.user.id,
      credit_note_required: creditNoteRequired,
    })
    .eq("id", orderId)
    .select()
    .single()

  if (updateError || !updatedOrder) {
    return NextResponse.json(
      { error: updateError?.message || "No se pudo marcar el reintegro." },
      { status: 500 },
    )
  }

  await appendOrderAuditEvent(auth.admin, {
    orderId,
    actorType: "admin",
    actorId: auth.user.id,
    action: "refund_proof_uploaded",
    previousStatus: order.financial_status ?? "refund_pending",
    newStatus: "refunded",
    metadata: {
      proofId: proof.id,
      fileName: file.name,
      filePath: storedPath,
      amount,
      method,
      observation,
      creditNoteRequired,
    },
  })

  await appendOrderAuditEvent(auth.admin, {
    orderId,
    actorType: "admin",
    actorId: auth.user.id,
    action: "order_refunded",
    previousStatus: order.financial_status ?? "refund_pending",
    newStatus: "refunded",
    metadata: {
      amount,
      method,
      proofId: proof.id,
    },
  })

  await notifyCustomerRefunded(auth.admin, updatedOrder)

  return NextResponse.json({
    order: updatedOrder,
    signedUrl: await createSignedRefundUrl(auth.admin, storedPath),
  })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const body = (await request.json()) as {
    action?: unknown
    creditNoteIssued?: unknown
    creditNoteNumber?: unknown
    confirmWithoutProof?: unknown
    observation?: unknown
    internalNote?: unknown
    amount?: unknown
    method?: unknown
  }

  const { data: order, error: orderError } = await auth.admin
    .from("ordenes")
    .select("id, estado, total, payment_status, paid_at, payment_confirmed_amount, financial_status, refund_proof_url, invoice_status, invoice_cae, invoice_number, invoice_point, credit_note_required")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (body.action === "update_credit_note") {
    if (!["refund_pending", "refunded"].includes(order.financial_status ?? "")) {
      return NextResponse.json(
        { error: "Sólo se pueden guardar datos contables en pedidos con reintegro pendiente o registrado." },
        { status: 409 },
      )
    }

    if (!isOrderInvoiced(order)) {
      return NextResponse.json(
        { error: "Este pedido no tiene factura emitida; no corresponde nota de crédito." },
        { status: 409 },
      )
    }

    const creditNoteIssued = body.creditNoteIssued === true
    const creditNoteNumber =
      typeof body.creditNoteNumber === "string"
        ? body.creditNoteNumber.trim().slice(0, 120)
        : ""

    if (creditNoteIssued && creditNoteNumber.length < 3) {
      return NextResponse.json(
        { error: "Ingresá el número de nota de crédito." },
        { status: 400 },
      )
    }

    const { data: updatedOrder, error: updateError } = await auth.admin
      .from("ordenes")
      .update({
        credit_note_required: true,
        credit_note_issued: creditNoteIssued,
        credit_note_number: creditNoteIssued ? creditNoteNumber : null,
        credit_note_issued_at: creditNoteIssued ? new Date().toISOString() : null,
      })
      .eq("id", orderId)
      .select()
      .single()

    if (updateError || !updatedOrder) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo guardar la nota de crédito." },
        { status: 500 },
      )
    }

    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action: creditNoteIssued
        ? "credit_note_registered"
        : "credit_note_marked_pending",
      previousStatus: order.financial_status ?? null,
      newStatus: updatedOrder.financial_status ?? null,
      metadata: {
        creditNoteNumber: creditNoteIssued ? creditNoteNumber : null,
      },
    })

    return NextResponse.json({ order: updatedOrder })
  }

  if (body.action === "mark_refunded_without_proof") {
    const observation =
      typeof body.observation === "string"
        ? body.observation.trim().slice(0, 1000) || null
        : ""
    const internalNote =
      typeof body.internalNote === "string"
        ? body.internalNote.trim().slice(0, 1200)
        : ""

    if (body.confirmWithoutProof !== true || internalNote.length < 10) {
      return NextResponse.json(
        { error: "Para marcar sin comprobante necesitás confirmación explícita y una observación interna obligatoria." },
        { status: 400 },
      )
    }

    if (!isRefundableOrder(order)) {
      return NextResponse.json(
        { error: "Sólo se puede reintegrar un pedido con reintegro pendiente." },
        { status: 409 },
      )
    }

    if (order.refund_proof_url) {
      return NextResponse.json(
        { error: "El pedido ya tiene un comprobante de reintegro." },
        { status: 409 },
      )
    }

    const amountLimit = getRefundAmountLimit(order)
    const amount = parseRefundAmount(body.amount)

    if (amount === null || amountLimit <= 0 || amount > amountLimit) {
      return NextResponse.json(
        {
          error:
            "Ingresá un monto de reintegro válido, mayor a cero y no superior al monto pagado.",
        },
        { status: 400 },
      )
    }

    const method =
      typeof body.method === "string"
        ? body.method.trim().slice(0, 120)
        : ""

    if (!method) {
      return NextResponse.json(
        { error: "Indicá el método de reintegro." },
        { status: 400 },
      )
    }

    const now = new Date().toISOString()
    const { data: updatedOrder, error: updateError } = await auth.admin
      .from("ordenes")
      .update({
        financial_status: "refunded",
        refund_amount: amount,
        refund_method: method,
        refund_observation: observation,
        refund_internal_note: internalNote,
        refund_uploaded_by: auth.user.id,
        refund_uploaded_at: now,
        refunded_at: now,
        refunded_by: auth.user.id,
        credit_note_required:
          Boolean(order.credit_note_required) || isOrderInvoiced(order),
      })
      .eq("id", orderId)
      .select()
      .single()

    if (updateError || !updatedOrder) {
      return NextResponse.json(
        { error: updateError?.message || "No se pudo marcar el reintegro." },
        { status: 500 },
      )
    }

    await appendOrderAuditEvent(auth.admin, {
      orderId,
      actorType: "admin",
      actorId: auth.user.id,
      action: "order_refunded_without_proof",
      previousStatus: order.financial_status ?? "refund_pending",
      newStatus: "refunded",
      metadata: {
        amount,
        method,
        observation,
        internalNote,
      },
    })

    return NextResponse.json({ order: updatedOrder })
  }

  return NextResponse.json({ error: "Acción inválida." }, { status: 400 })
}
