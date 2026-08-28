import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import type { SupabasePedido } from "@/lib/supabase/types"

const CUSTOMER_ORDER_DETAIL_SELECT =
  "id, usuario_id, cliente_nombre, cliente_email, cliente_telefono, cliente_dni, cliente_direccion, cp_destino, localidad, provincia, shipping_provider, shipping_type, shipping_cost_real, shipping_cost_charged, free_shipping_applied, estado, total, original_total, credit_balance_used, external_amount_due, payment_status, payment_method_id, payment_type_id, transfer_discount_percent, transfer_discount_amount, payment_proof_url, payment_proof_file_name, payment_proof_uploaded_at, financial_status, cancellation_requested_at, refund_pending_at, refund_proof_url, refund_amount, refund_method, refund_observation, refunded_at, credit_note_status, credit_note_number, credit_note_point, credit_note_cae, credit_note_cae_due, credit_note_created_at, credit_note_amount, paid_at, tracking_number, tracking_url, envio_proveedor, andreani_estado, andreani_tracking, andreani_sucursal_nombre, andreani_sucursal_direccion, andreani_sucursal_localidad, andreani_sucursal_provincia, andreani_sucursal_cp, invoice_number, invoice_point, invoice_cae, invoice_cae_due, invoice_status, invoice_created_at, return_status, return_reason, return_requested_at, return_resolved_at, delivered_at, cancelled_at, created_at, orden_items(id, orden_id, producto_id, variante_id, conditioned_stock_id, conditioned_name, conditioned_sku, conditioned_color_hex, conditioned_images, conditioned_discount_percent, conditioned_reason, cantidad, precio, productos(nombre, imagen_principal, imagenes_producto(url)), producto_variantes(nombre, imagenes))"

function escapeIlikeValue(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const orderId = Number(id)

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const admin = createAdminClient()
  const byUserId = await admin
    .from("ordenes")
    .select(CUSTOMER_ORDER_DETAIL_SELECT)
    .eq("id", orderId)
    .eq("usuario_id", user.id)
    .maybeSingle()

  if (byUserId.error) {
    return NextResponse.json(
      { error: "No se pudo cargar la compra." },
      { status: 500 },
    )
  }

  let order = byUserId.data
  const normalizedEmail = user.email?.trim().toLowerCase()

  // Compatibilidad exclusivamente para pedidos históricos que nunca fueron
  // asociados a un usuario. Un email jamás puede reemplazar otro usuario_id.
  if (!order && normalizedEmail) {
    const byLegacyEmail = await admin
      .from("ordenes")
      .select(CUSTOMER_ORDER_DETAIL_SELECT)
      .eq("id", orderId)
      .is("usuario_id", null)
      .ilike("cliente_email", escapeIlikeValue(normalizedEmail))
      .maybeSingle()

    if (byLegacyEmail.error) {
      return NextResponse.json(
        { error: "No se pudo cargar la compra." },
        { status: 500 },
      )
    }
    order = byLegacyEmail.data
  }

  if (!order) {
    return NextResponse.json({ error: "No encontramos la compra." }, { status: 404 })
  }

  return NextResponse.json({ order: order as unknown as SupabasePedido }, {
    headers: { "Cache-Control": "private, no-store" },
  })
}
