import { NextResponse } from "next/server"

import { requireOperator } from "@/app/api/admin/clientes/_auth"
import { signClaims } from "@/lib/orders/claim-server"
import type { SupabaseOrderClaim } from "@/lib/supabase/types"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireOperator(request)
  if ("error" in auth) return auth.error

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const { data, error } = await auth.admin
    .from("order_claims")
    .select("*, order_claim_files(*), order_claim_messages(*)")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("GET /api/admin/pedidos/[id]/claims", orderId, error.message)
    return NextResponse.json(
      { error: "No se pudieron cargar los mensajes." },
      { status: 500 },
    )
  }

  const claims = await signClaims(auth.admin, (data ?? []) as SupabaseOrderClaim[])

  return NextResponse.json({ claims })
}
