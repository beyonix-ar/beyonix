import { NextResponse } from "next/server"

import {
  PAYMENT_PROOF_BUCKET,
  getPaymentProofValidationError,
  sanitizePaymentProofFileName,
} from "@/lib/payments/transfer"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

function normalizeStoredPath(path: string) {
  return path.startsWith(`${PAYMENT_PROOF_BUCKET}/`)
    ? path
    : `${PAYMENT_PROOF_BUCKET}/${path}`
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
    }

    const formData = await request.formData()
    const orderId = Number(formData.get("orderId"))
    const file = formData.get("file")

    if (!Number.isFinite(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Pedido invalido." }, { status: 400 })
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Seleccioná un comprobante para subir." },
        { status: 400 },
      )
    }

    const validationError = getPaymentProofValidationError(file)

    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 })
    }

    const { data: order, error: orderError } = await supabase
      .from("ordenes")
      .select("id, usuario_id, payment_method_id")
      .eq("id", orderId)
      .single()

    if (orderError || !order) {
      return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
    }

    if (order.usuario_id !== user.id) {
      return NextResponse.json({ error: "No autorizado." }, { status: 403 })
    }

    if (order.payment_method_id !== "transferencia") {
      return NextResponse.json(
        { error: "Este pedido no corresponde a transferencia bancaria." },
        { status: 400 },
      )
    }

    const admin = createAdminClient()
    const safeName = sanitizePaymentProofFileName(file.name)
    const path = `${orderId}/${Date.now()}-${safeName}`
    const { error: uploadError } = await admin.storage
      .from(PAYMENT_PROOF_BUCKET)
      .upload(path, file, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      throw new Error(uploadError.message || "No se pudo subir el comprobante.")
    }

    const storedPath = normalizeStoredPath(path)
    const uploadedAt = new Date().toISOString()
    const { data: updatedOrder, error: updateError } = await admin
      .from("ordenes")
      .update({
        payment_status: "en_revision",
        payment_proof_url: storedPath,
        payment_proof_file_name: file.name,
        payment_proof_uploaded_at: uploadedAt,
      })
      .eq("id", orderId)
      .select()
      .single()

    if (updateError || !updatedOrder) {
      throw new Error(updateError?.message || "No se pudo guardar el comprobante.")
    }

    return NextResponse.json({ order: updatedOrder })
  } catch (error) {
    console.error("payment proof upload error", error)

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "No pudimos subir el comprobante.",
      },
      { status: 500 },
    )
  }
}
