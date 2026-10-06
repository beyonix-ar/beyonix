import "server-only"

import type { AdminApiAuth } from "../auth/admin-api.ts"
import type { createAdminClient } from "../supabase/admin.ts"
import {
  PAYMENT_METHOD_LOGO_SELECT,
  PAYMENT_METHOD_LOGOS_BUCKET,
  parseMercadoPagoPaymentMethods,
  planPaymentMethodSync,
  toAdminPaymentMethodLogo,
  toPublicPaymentMethodLogos,
  type AdminPaymentMethodsOverview,
  type MercadoPagoPaymentMethodSummary,
  type PaymentMethodLogoRow,
  type PaymentMethodsSyncState,
  type PaymentMethodSyncPlan,
  type PublicPaymentMethodLogo,
} from "./payment-method-logos.ts"

type AdminClient = ReturnType<typeof createAdminClient>
type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export const PAYMENT_METHODS_SYNC_KEY = "payment_methods_sync"
export const MERCADOPAGO_PAYMENT_METHODS_URL = "https://api.mercadopago.com/v1/payment_methods"
const MERCADOPAGO_PAYMENT_METHODS_TIMEOUT_MS = 8_000

const EMPTY_SYNC_STATE: PaymentMethodsSyncState = { lastAttemptAt: null, lastSuccessAt: null, lastError: null }

type MercadoPagoFetchFailure = "not_configured" | "timeout" | "http_error" | "invalid_response" | "network_error"

const FETCH_FAILURE_MESSAGES: Record<MercadoPagoFetchFailure, string> = {
  not_configured: "Mercado Pago no está configurado en el servidor (falta el access token).",
  timeout: "Mercado Pago no respondió a tiempo.",
  http_error: "Mercado Pago rechazó la consulta de medios de pago.",
  invalid_response: "Mercado Pago devolvió una respuesta con formato inesperado.",
  network_error: "No se pudo conectar con Mercado Pago.",
}

/**
 * `GET /v1/payment_methods` con el access token del servidor (nunca desde el
 * navegador). Nunca lanza: devuelve el motivo resumido, sin secretos.
 */
export async function fetchMercadoPagoPaymentMethods(
  { fetch: fetcher = fetch, accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN }: { fetch?: Fetcher; accessToken?: string | null } = {},
): Promise<{ ok: true; methods: MercadoPagoPaymentMethodSummary[] } | { ok: false; reason: MercadoPagoFetchFailure }> {
  if (!accessToken) return { ok: false, reason: "not_configured" }
  try {
    const response = await fetcher(MERCADOPAGO_PAYMENT_METHODS_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(MERCADOPAGO_PAYMENT_METHODS_TIMEOUT_MS),
      cache: "no-store",
    })
    if (!response.ok) return { ok: false, reason: "http_error" }
    const methods = parseMercadoPagoPaymentMethods((await response.json()) as unknown)
    return methods ? { ok: true, methods } : { ok: false, reason: "invalid_response" }
  } catch (error) {
    const reason: MercadoPagoFetchFailure =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timeout"
        : error instanceof SyntaxError
          ? "invalid_response"
          : "network_error"
    console.error("MERCADOPAGO_PAYMENT_METHODS_FETCH_FAILED", { reason })
    return { ok: false, reason }
  }
}

function toSyncState(value: unknown): PaymentMethodsSyncState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_SYNC_STATE
  const record = value as Record<string, unknown>
  const text = (key: string) => (typeof record[key] === "string" ? (record[key] as string) : null)
  return { lastAttemptAt: text("lastAttemptAt"), lastSuccessAt: text("lastSuccessAt"), lastError: text("lastError") }
}

export async function loadPaymentMethodsSyncState(admin: AdminClient): Promise<PaymentMethodsSyncState> {
  const { data, error } = await admin.from("site_settings").select("value").eq("key", PAYMENT_METHODS_SYNC_KEY).maybeSingle()
  if (error) throw new Error("No se pudo leer el estado de sincronización de medios de pago.")
  return toSyncState(data?.value)
}

async function saveSyncState(admin: AdminClient, state: PaymentMethodsSyncState, updatedBy: string | null) {
  const { error } = await admin.from("site_settings").upsert(
    { key: PAYMENT_METHODS_SYNC_KEY, value: state, updated_by: updatedBy, updated_at: state.lastAttemptAt ?? new Date().toISOString() },
    { onConflict: "key" },
  )
  return !error
}

export async function loadPaymentMethodLogoRows(admin: AdminClient): Promise<PaymentMethodLogoRow[]> {
  const { data, error } = await admin
    .from("payment_method_logos")
    .select(PAYMENT_METHOD_LOGO_SELECT)
    .order("source", { ascending: false })
    .order("display_name", { ascending: true })
  if (error) throw new Error("No se pudieron leer los medios de pago.")
  return (data ?? []) as PaymentMethodLogoRow[]
}

async function applySyncPlan(admin: AdminClient, plan: PaymentMethodSyncPlan) {
  if (plan.inserts.length) {
    // ignoreDuplicates: dos sincronizaciones simultáneas nunca duplican un id
    // ni pisan imagen/habilitación de una fila existente.
    const { error } = await admin
      .from("payment_method_logos")
      .upsert(plan.inserts, { onConflict: "source,provider_method_id", ignoreDuplicates: true })
    if (error) throw new Error("No se pudieron registrar los medios nuevos.")
  }
  const results = await Promise.all(
    plan.updates.map(({ id, changes }) => admin.from("payment_method_logos").update(changes).eq("id", id)),
  )
  if (results.some((result) => result.error)) throw new Error("No se pudo actualizar el estado de los medios de pago.")
}

export type PaymentMethodsSyncResult =
  | { ok: true; state: PaymentMethodsSyncState; summary: PaymentMethodSyncPlan["summary"] }
  | { ok: false; state: PaymentMethodsSyncState; error: string }

/**
 * "Actualizar desde Mercado Pago". Si Mercado Pago falla, no se toca ninguna
 * fila (se conserva el último estado conocido) y sólo se registra el fallo.
 */
export async function syncPaymentMethodLogos(
  admin: AdminClient,
  { updatedBy = null, now = new Date(), fetch: fetcher, accessToken }: {
    updatedBy?: string | null
    now?: Date
    fetch?: Fetcher
    accessToken?: string | null
  } = {},
): Promise<PaymentMethodsSyncResult> {
  const attemptedAt = now.toISOString()
  const previous = await loadPaymentMethodsSyncState(admin)
  const fetched = await fetchMercadoPagoPaymentMethods({ fetch: fetcher, accessToken })

  if (!fetched.ok) {
    const state = { ...previous, lastAttemptAt: attemptedAt, lastError: FETCH_FAILURE_MESSAGES[fetched.reason] }
    await saveSyncState(admin, state, updatedBy)
    return { ok: false, state, error: FETCH_FAILURE_MESSAGES[fetched.reason] }
  }

  try {
    const plan = planPaymentMethodSync(await loadPaymentMethodLogoRows(admin), fetched.methods, attemptedAt)
    await applySyncPlan(admin, plan)
    const state = { lastAttemptAt: attemptedAt, lastSuccessAt: attemptedAt, lastError: null }
    if (!(await saveSyncState(admin, state, updatedBy))) {
      return { ok: false, state: previous, error: "No se pudo guardar la sincronización." }
    }
    return { ok: true, state, summary: plan.summary }
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo sincronizar."
    const state = { ...previous, lastAttemptAt: attemptedAt, lastError: message }
    await saveSyncState(admin, state, updatedBy)
    return { ok: false, state, error: message }
  }
}

/** Mismo registro de auditoría que el resto de Admin (banners, configuración). */
export async function recordPaymentMethodAudit(
  auth: Pick<AdminApiAuth, "admin" | "user" | "profile">,
  action: "INSERT" | "UPDATE" | "DELETE",
  recordId: string,
  before: unknown,
  after: unknown,
) {
  const { error } = await auth.admin.from("audit_logs").insert({
    table_name: "payment_method_logos",
    action,
    record_id: recordId,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email,
    before_data: before,
    after_data: after,
  })
  if (error) console.error("PAYMENT_METHOD_AUDIT_FAILED", { recordId, action })
}

export function getPaymentLogoPublicUrl(admin: AdminClient, path: string) {
  return admin.storage.from(PAYMENT_METHOD_LOGOS_BUCKET).getPublicUrl(path).data.publicUrl
}

export async function loadAdminPaymentMethodsOverview(admin: AdminClient): Promise<AdminPaymentMethodsOverview> {
  const [rows, sync] = await Promise.all([loadPaymentMethodLogoRows(admin), loadPaymentMethodsSyncState(admin)])
  return {
    sync,
    methods: rows.map((row) => toAdminPaymentMethodLogo(row, row.image_path ? getPaymentLogoPublicUrl(admin, row.image_path) : null)),
  }
}

export async function loadPublicPaymentMethodLogos(admin: AdminClient): Promise<PublicPaymentMethodLogo[]> {
  return toPublicPaymentMethodLogos(await loadPaymentMethodLogoRows(admin), (path) => getPaymentLogoPublicUrl(admin, path))
}
