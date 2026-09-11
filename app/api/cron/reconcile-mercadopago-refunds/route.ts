import { NextResponse } from "next/server"

import { isCronRequestAuthorized } from "@/lib/auth/cron-auth"
import { runMercadoPagoRefundReconciliationBatch } from "@/lib/mercadopago/reconciliation-batch"
import { createAdminClient } from "@/lib/supabase/admin"

/**
 * Reconciliación por lote de refunds 'needs_reconciliation'. Reutiliza el
 * mismo mecanismo de autorización que el resto de los crons (CRON_SECRET,
 * lib/auth/cron-auth.ts) -- falla cerrado si no está configurado, igual que
 * /api/cron/expire-transfer-orders y /api/cron/andreani-sync-tracking.
 *
 * Todavía sin programar (ni Vercel cron ni systemd timer) a propósito: el
 * endpoint queda listo, protegido, para que se decida el mecanismo de
 * scheduling por separado.
 */
export async function GET(request: Request) {
  if (
    !isCronRequestAuthorized(
      request.headers.get("authorization"),
      process.env.CRON_SECRET,
    )
  ) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  try {
    const result = await runMercadoPagoRefundReconciliationBatch(createAdminClient())
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error("MERCADOPAGO_REFUND_RECONCILIATION_BATCH_ERROR", {
      message: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ ok: false, error: "No se pudo reconciliar el lote." }, { status: 502 })
  }
}
