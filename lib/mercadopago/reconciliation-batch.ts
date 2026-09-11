import "server-only"

import type { createAdminClient } from "@/lib/supabase/admin"

import { reconcileRefundAttempt } from "./order-refund.ts"
import type { getMercadoPagoRefundStatus } from "./refunds.ts"

type AdminClient = ReturnType<typeof createAdminClient>

interface ClaimedRefundRow {
  id: string
  order_id: number
  payment_id: string
  mp_refund_id: string | null
}

export interface MercadoPagoRefundReconciliationBatchResult {
  /** Intentos 'needs_reconciliation' tomados en este lote. */
  checked: number
  /** Confirmados contra Mercado Pago en esta corrida. */
  confirmed: number
  /** Siguen ambiguos (needs_reconciliation) o quedaron intentables de nuevo (requested). */
  stillPending: number
  /** Fallos al reconsultar (no bloquean el resto del lote). */
  errors: number
}

/**
 * Job de reconciliación para refunds 'needs_reconciliation'. Server-side
 * únicamente, pensado para correr desde un cron/systemd timer (ver
 * app/api/cron/reconcile-mercadopago-refunds/route.ts). NUNCA dispara un
 * POST de refund -- sólo reconsulta por GET (reconcileRefundAttempt) y
 * registra el resultado real.
 *
 * `claim_mercadopago_refunds_for_reconciliation` (FOR UPDATE SKIP LOCKED)
 * es lo que impide que dos corridas concurrentes de este job (dos workers,
 * o un timer superpuesto con la corrida anterior todavía en curso) tomen el
 * mismo registro.
 */
export async function runMercadoPagoRefundReconciliationBatch(
  admin: AdminClient,
  dependencies: {
    batchSize?: number
    lockTimeoutSeconds?: number
    getRefundStatus?: (
      paymentId: string,
      refundId: string | null,
    ) => ReturnType<typeof getMercadoPagoRefundStatus>
  } = {},
): Promise<MercadoPagoRefundReconciliationBatchResult> {
  const batchSize = dependencies.batchSize ?? 10
  const lockTimeoutSeconds = dependencies.lockTimeoutSeconds ?? 300

  const { data, error } = await admin.rpc("claim_mercadopago_refunds_for_reconciliation", {
    p_batch_size: batchSize,
    p_lock_timeout_seconds: lockTimeoutSeconds,
  })

  if (error) {
    throw new Error(error.message || "No se pudo reservar el lote de refunds a reconciliar.")
  }

  const rows = (data ?? []) as ClaimedRefundRow[]
  let confirmed = 0
  let stillPending = 0
  let errors = 0

  for (const row of rows) {
    try {
      const result = await reconcileRefundAttempt(
        admin,
        { id: row.id, payment_id: row.payment_id, mp_refund_id: row.mp_refund_id },
        { getRefundStatus: dependencies.getRefundStatus },
      )
      if (result.kind === "confirmed") confirmed += 1
      else stillPending += 1
    } catch (reconciliationError) {
      errors += 1
      console.error("MERCADOPAGO_REFUND_RECONCILIATION_ITEM_ERROR", {
        refundAttemptId: row.id,
        orderId: row.order_id,
        message:
          reconciliationError instanceof Error
            ? reconciliationError.message
            : String(reconciliationError),
      })
    }
  }

  return { checked: rows.length, confirmed, stillPending, errors }
}
