import "server-only"

import type { createAdminClient } from "../supabase/admin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Ventana COMERCIAL de un pedido por transferencia: el expires_at original de
 * la reserva del Paso 3 (20 minutos), ligado al pedido por
 * commit_transfer_checkout_reservation. Es la única fuente de verdad del
 * contador y del flujo normal de pago; nunca se renueva.
 *
 * No confundir con la ventana TÉCNICA de conciliación
 * (TRANSFER_PAYMENT_EXPIRATION_HOURS, 48 h): durante esa ventana el cron puede
 * seguir detectando una transferencia tardía, pero sin garantía de stock --
 * guard_transfer_reservation_confirmation revalida el stock al confirmar.
 *
 * Sin sesión (pedido anterior a esta fase) devuelve null: el flujo normal se
 * trata como vencido (fail-closed).
 */
export async function loadTransferReservationDeadline(
  admin: AdminClient,
  orderId: number,
): Promise<string | null> {
  const { data, error } = await admin
    .from("checkout_reservation_sessions")
    .select("expires_at")
    .eq("order_id", orderId)
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(error.message || "No se pudo leer la reserva del pedido.")
  }
  return typeof data?.expires_at === "string" ? data.expires_at : null
}

/**
 * "Mis compras": adjunta a cada pedido por transferencia que sigue esperando
 * el pago el expires_at ORIGINAL de su reserva (una sola consulta para toda
 * la lista). Sólo lectura: nunca crea ni renueva una reserva. null = sin
 * reserva vigente registrada (se muestra como vencida).
 */
export async function attachTransferReservationDeadlines<
  T extends {
    id: number
    estado?: string | null
    payment_method_id?: string | null
    payment_status?: string | null
    payment_proof_url?: string | null
    payment_proof_uploaded_at?: string | null
  },
>(admin: AdminClient, orders: T[]): Promise<Array<T & { transfer_reservation_expires_at?: string | null }>> {
  const awaiting = orders.filter((order) =>
    order.payment_method_id === "transferencia" &&
    order.estado === "pendiente" &&
    (order.payment_status || "pendiente_comprobante") === "pendiente_comprobante" &&
    !order.payment_proof_url &&
    !order.payment_proof_uploaded_at)
  if (awaiting.length === 0) return orders

  const { data, error } = await admin
    .from("checkout_reservation_sessions")
    .select("order_id, expires_at")
    .in("order_id", awaiting.map((order) => order.id))
  if (error) {
    throw new Error(error.message || "No se pudieron leer las reservas de los pedidos.")
  }

  const deadlines = new Map<number, string>()
  for (const row of (data ?? []) as Array<{ order_id: number | string | null; expires_at: string | null }>) {
    const orderId = Number(row.order_id)
    if (!row.expires_at || !Number.isSafeInteger(orderId)) continue
    const current = deadlines.get(orderId)
    if (!current || Date.parse(row.expires_at) > Date.parse(current)) deadlines.set(orderId, row.expires_at)
  }
  const awaitingIds = new Set(awaiting.map((order) => order.id))
  return orders.map((order) =>
    awaitingIds.has(order.id)
      ? { ...order, transfer_reservation_expires_at: deadlines.get(order.id) ?? null }
      : order)
}

export function isTransferReservationActive(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
  return Number.isFinite(expiry) && expiry > now.getTime()
}
