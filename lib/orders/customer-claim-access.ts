import "server-only"

import { NextResponse } from "next/server"

import { isCustomerOrderOwner } from "./customer-order-ownership.ts"
import { claimErrorResponse } from "./claim-server.ts"
import { createAdminClient } from "../supabase/admin.ts"
import { createClient } from "../supabase/server.ts"

/**
 * Acceso del cliente a los reclamos de UN pedido: sesión obligatoria, id
 * válido y titularidad verificada server-side (nunca se confía en el orderId
 * del frontend). Compartido por /api/orders/[id]/claims y .../claims/read.
 */
export async function authorizeCustomerClaimOrder(rawId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { response: NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 }) }
  const orderId = Number(rawId)
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return { response: claimErrorResponse(new Error("CLAIM_INVALID")) }
  const admin = createAdminClient()
  const { data: order, error } = await admin.from("ordenes").select("id, usuario_id, cliente_email, estado, delivered_at").eq("id", orderId).maybeSingle()
  if (error || !order) return { response: NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 }) }
  if (!isCustomerOrderOwner(order, user) || !order.usuario_id && !user.email_confirmed_at) return { response: claimErrorResponse(new Error("CLAIM_FORBIDDEN")) }
  return { admin, order, user }
}

type AdminClient = ReturnType<typeof createAdminClient>

/** Adjunta `customer_last_read_at` a reclamos del cliente (sólo los suyos). */
export async function attachCustomerClaimReads<T extends { id?: number }>(
  admin: AdminClient,
  userId: string,
  claims: T[],
): Promise<Array<T & { customer_last_read_at: string | null }>> {
  const ids = claims.map((claim) => claim.id).filter((id): id is number => typeof id === "number")
  if (!ids.length) return claims.map((claim) => ({ ...claim, customer_last_read_at: null }))
  const { data } = await admin
    .from("order_claim_customer_reads")
    .select("claim_id, last_read_at")
    .eq("user_id", userId)
    .in("claim_id", ids)
  const byClaim = new Map((data ?? []).map((row) => [row.claim_id as number, row.last_read_at as string]))
  return claims.map((claim) => ({
    ...claim,
    customer_last_read_at: typeof claim.id === "number" ? byClaim.get(claim.id) ?? null : null,
  }))
}
