import "server-only"

import { getInterestFreeInstallments } from "./interest-free-installments.ts"
import type { MercadoPagoInterestFreeStatus } from "./interest-free-policy.ts"
import { probeMercadoPagoInterestFreeReference } from "./interest-free-reference.ts"
import {
  getMercadoPagoInterestFreeStatus,
  invalidateSiteSettingsCache,
  MERCADOPAGO_INTEREST_FREE_REFERENCE_KEY,
} from "../site-settings.ts"
import type { createAdminClient } from "../supabase/admin.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export const MERCADOPAGO_SYNC_FAILURE_MESSAGE =
  "Mercado Pago no respondió de forma confiable (error, demora o límite de consultas)."

/**
 * Consulta FRESCA a Mercado Pago (sin caché) desde qué total confirma 2, 3 y
 * 6 cuotas sin interés y guarda el resultado. Si falla, se conserva la última
 * referencia exitosa sólo como dato histórico y se registra el fallo (hora y
 * mensaje resumido, sin secretos): mientras el último intento esté fallido,
 * la tienda no comunica ninguna promoción. La usan el cron periódico y el
 * botón "Comprobar ahora" de Admin → Financiación.
 */
export async function syncMercadoPagoInterestFreeReference(
  admin: AdminClient,
  { updatedBy = null, now = new Date() }: { updatedBy?: string | null; now?: Date } = {},
): Promise<{ ok: boolean; status: MercadoPagoInterestFreeStatus; error?: string }> {
  const reference = await probeMercadoPagoInterestFreeReference(
    (amount) => getInterestFreeInstallments(amount, { fresh: true }),
    now,
  )
  const previous = await getMercadoPagoInterestFreeStatus()
  const status: MercadoPagoInterestFreeStatus = reference
    ? { reference, lastAttemptAt: now.toISOString(), lastError: null }
    : { reference: previous.reference, lastAttemptAt: now.toISOString(), lastError: MERCADOPAGO_SYNC_FAILURE_MESSAGE }

  const { error } = await admin.from("site_settings").upsert(
    {
      key: MERCADOPAGO_INTEREST_FREE_REFERENCE_KEY,
      value: status,
      updated_by: updatedBy,
      updated_at: now.toISOString(),
    },
    { onConflict: "key" },
  )
  if (error) {
    return { ok: false, status: previous, error: "No se pudo guardar la sincronización con Mercado Pago." }
  }
  invalidateSiteSettingsCache()
  return reference ? { ok: true, status } : { ok: false, status, error: MERCADOPAGO_SYNC_FAILURE_MESSAGE }
}
