import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"
import { roundCreditMoney } from "./credit-note-calculations.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export const COMMITTED_CREDIT_NOTE_STATUSES = ["authorized", "processing"]

/**
 * Regla financiera real: cuánto todavía puede acreditarse/reembolsarse por
 * un pedido = su total menos lo ya comprometido en notas de crédito
 * autorizadas o en proceso. Es la misma cuenta que ya hace el wizard de
 * devoluciones (invoiceCreditRemaining) para no dejar que ningún estado
 * intermedio registre un importe mayor al que el pedido puede respaldar.
 */
export function calculateRemainingCreditableAmount(
  orderTotal: number,
  creditNotes: ReadonlyArray<{
    status: string | null
    total_amount: number | string | null
  }>,
): number {
  const committed = creditNotes
    .filter((note) =>
      COMMITTED_CREDIT_NOTE_STATUSES.includes(String(note.status)),
    )
    .reduce((sum, note) => sum + Number(note.total_amount ?? 0), 0)

  return Math.max(0, roundCreditMoney(Number(orderTotal ?? 0) - committed))
}

/**
 * Devuelve `null` si no se pudo leer el pedido (el caller decide cómo
 * tratarlo — nunca se debe interpretar `null` como "sin límite").
 */
export async function getRemainingCreditableAmount(
  admin: AdminClient,
  orderId: number,
): Promise<number | null> {
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("total")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) return null

  const { data: notes, error: notesError } = await admin
    .from("order_credit_notes")
    .select("total_amount, status")
    .eq("order_id", orderId)

  if (notesError) return null

  return calculateRemainingCreditableAmount(
    Number(order.total ?? 0),
    notes ?? [],
  )
}
