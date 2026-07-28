import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import { sendOrderStatusEmail } from "@/lib/email/send-order-status-email"
import { appendOrderAuditEvent } from "@/lib/orders/order-audit"
import {
  PAYMENT_PROOF_BUCKET,
  getPaymentProofValidationError,
  sanitizePaymentProofFileName,
} from "@/lib/payments/transfer"

const REFUND_PROOF_MIME_TYPES = new Set(["image/jpeg", "application/pdf"])

function getRefundProofValidationError(file: File) {
  const generalError = getPaymentProofValidationError(file)
  if (generalError) return generalError

  const extension = file.name.split(".").pop()?.trim().toLowerCase()
  if (
    !REFUND_PROOF_MIME_TYPES.has(file.type) ||
    !["jpg", "jpeg", "pdf"].includes(extension ?? "")
  ) {
    return "El comprobante de reintegro debe ser JPG, JPEG o PDF."
  }

  return null
}

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
    [
      "pagado",
      "enviado",
      "en_camino",
      "visita_fallida",
      "en_sucursal",
      "retiro_pendiente",
      "retiro_vencido",
      "en_devolucion",
      "devuelto_beyonix",
      "entregado",
    ].includes(order.estado ?? "")
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

function getOrderCode(orderId: number) {
  return `BX-${1000 + orderId}`
}

async function getAuthorizedExternalRefund(admin: any, orderId: number) {
  const { data, error } = await admin
    .from("order_credit_notes")
    .select("id, total_amount")
    .eq("order_id", orderId)
    .eq("status", "authorized")
    .eq("destination", "external_refund")

  if (error) {
    return {
      response: NextResponse.json(
        { error: "No se pudo verificar la nota de crédito autorizada." },
        { status: 500 },
      ),
    }
  }

  const amount = Number((data ?? []).reduce(
    (sum: number, note: { total_amount?: number | string | null }) =>
      sum + Number(note.total_amount ?? 0),
    0,
  ).toFixed(2))

  if (amount <= 0) {
    return {
      response: NextResponse.json(
        {
          error:
            "Primero emití y validá en ARCA una nota de crédito con destino a devolución de dinero.",
        },
        { status: 409 },
      ),
    }
  }

  return {
    amount,
    noteIds: (data ?? []).map((note: { id: string }) => note.id),
  }
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

  const validationError = getRefundProofValidationError(file)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }

  const [orderResult, authorizedRefund] = await Promise.all([
    auth.admin
      .from("ordenes")
      .select("id, estado, payment_status, paid_at, financial_status")
      .eq("id", orderId)
      .maybeSingle(),
    getAuthorizedExternalRefund(auth.admin, orderId),
  ])
  const { data: order, error: orderError } = orderResult

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (!isRefundableOrder(order)) {
    return NextResponse.json(
      { error: "Sólo se puede reintegrar un pedido con reintegro pendiente." },
      { status: 409 },
    )
  }

  if ("response" in authorizedRefund) return authorizedRefund.response

  const { amount, noteIds } = authorizedRefund
  const method = "Devolución de dinero"
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
      observation: null,
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
      refund_uploaded_by: auth.user.id,
      refund_uploaded_at: now,
      refunded_at: now,
      refunded_by: auth.user.id,
      credit_note_required: false,
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

  await auth.admin
    .from("order_credit_notes")
    .update({
      management_status: "finalizada",
      settlement_status: "completado",
      settlement_date: now.slice(0, 10),
      settlement_reference: String(proof.id),
      updated_at: now,
    })
    .in("id", noteIds)

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
      creditNoteIds: noteIds,
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
      creditNoteIds: noteIds,
    },
  })

  await notifyCustomerRefunded(auth.admin, updatedOrder)

  return NextResponse.json({
    order: updatedOrder,
    signedUrl: await createSignedRefundUrl(auth.admin, storedPath),
  })
}
