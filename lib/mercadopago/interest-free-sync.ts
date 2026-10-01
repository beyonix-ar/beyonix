import "server-only"

import {
  getInterestFreeInstallments,
  type InterestFreeUnavailableReason,
} from "./interest-free-installments.ts"
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

const FAILURE_MESSAGES: Record<InterestFreeUnavailableReason, string> = {
  not_configured: "Mercado Pago no está configurado en el servidor (falta el access token).",
  invalid_amount: MERCADOPAGO_SYNC_FAILURE_MESSAGE,
  rate_limited: "Se alcanzó el límite de consultas a Mercado Pago. Se reintenta en la próxima sincronización.",
  timeout: "Mercado Pago no respondió a tiempo.",
  http_error: "Mercado Pago rechazó la consulta de cuotas (error HTTP).",
  invalid_response: "Mercado Pago devolvió una respuesta de cuotas con formato inesperado.",
  network_error: "No se pudo conectar con Mercado Pago.",
}

export function describeMercadoPagoSyncFailure(reason: InterestFreeUnavailableReason | undefined) {
  return reason ? FAILURE_MESSAGES[reason] : MERCADOPAGO_SYNC_FAILURE_MESSAGE
}

/**
 * Consulta FRESCA a Mercado Pago (sin caché) desde qué total confirma 2, 3 y
 * 6 cuotas sin interés y guarda el resultado. Si falla, se conserva la última
 * referencia exitosa sólo como dato histórico y se registra el fallo (hora y
 * mensaje resumido, sin secretos): mientras el último intento esté fallido,
 * la tienda no comunica ninguna promoción. La usan la sincronización
 * periódica del servidor (deploy/systemd) y "Comprobar ahora" de Admin →
 * Financiación.
 */
export async function syncMercadoPagoInterestFreeReference(
  admin: AdminClient,
  { updatedBy = null, now = new Date() }: { updatedBy?: string | null; now?: Date } = {},
): Promise<{ ok: boolean; status: MercadoPagoInterestFreeStatus; error?: string }> {
  const probe = await probeMercadoPagoInterestFreeReference(
    (amount) => getInterestFreeInstallments(amount, { fresh: true }),
    now,
  )
  const previous = await getMercadoPagoInterestFreeStatus()
  const attemptedAt = now.toISOString()
  const failureMessage = probe.ok ? null : describeMercadoPagoSyncFailure(probe.reason)
  const status: MercadoPagoInterestFreeStatus = probe.ok
    ? { reference: probe.reference, lastAttemptAt: attemptedAt, lastError: null, lastFailure: previous.lastFailure }
    : {
        reference: previous.reference,
        lastAttemptAt: attemptedAt,
        lastError: failureMessage,
        lastFailure: { at: attemptedAt, message: failureMessage ?? MERCADOPAGO_SYNC_FAILURE_MESSAGE },
      }

  const { error } = await admin.from("site_settings").upsert(
    {
      key: MERCADOPAGO_INTEREST_FREE_REFERENCE_KEY,
      value: status,
      updated_by: updatedBy,
      updated_at: attemptedAt,
    },
    { onConflict: "key" },
  )
  if (error) {
    return { ok: false, status: previous, error: "No se pudo guardar la sincronización con Mercado Pago." }
  }
  invalidateSiteSettingsCache()
  return probe.ok ? { ok: true, status } : { ok: false, status, error: failureMessage ?? MERCADOPAGO_SYNC_FAILURE_MESSAGE }
}
