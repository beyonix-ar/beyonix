import "server-only"

import { computeBulkPriceUpdate, isBulkPriceActionKind } from "../pricing/bulk-price-engine.ts"
import { normalizeBulkTargetItems, resolveBulkTargetProducts } from "../pricing/bulk-price-targets.ts"
import { invalidateSiteSettingsCache } from "../site-settings.ts"
import type { createAdminClient } from "../supabase/admin.ts"
import {
  COMMERCIAL_EVENT_COLUMNS,
  describeExecutionError,
  getDueEventActions,
  type CommercialEventRow,
} from "./scheduled-events.ts"

type AdminClient = ReturnType<typeof createAdminClient>

export type EventPhaseResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string }

function rpcErrorText(error: { message?: string; details?: string } | null) {
  return [error?.message, error?.details].filter(Boolean).join(" ")
}

/** Auditoría de cada ejecución (sin `before_data`: nunca se "deshace" desde Auditoría). */
async function auditExecution(
  admin: AdminClient,
  event: CommercialEventRow,
  phase: "apply" | "restore",
  now: Date,
  outcome: Record<string, unknown>,
) {
  const { error } = await admin.from("audit_logs").insert({
    table_name: "product_bulk_events",
    action: "UPDATE",
    record_id: event.id,
    actor_user_id: null,
    actor_email: null,
    before_data: null,
    after_data: {
      event_type: phase === "apply" ? "scheduled_apply" : "scheduled_restore",
      event_name: event.internal_name,
      commercial_event_type: event.event_type,
      created_by: event.created_by,
      scheduled_at: phase === "apply" ? event.starts_at : event.ends_at,
      executed_at: now.toISOString(),
      previous_policy: event.previous_financing_policy,
      applied_policy: event.financing_policy,
      ...outcome,
    },
  })
  if (error) console.error("COMMERCIAL_EVENT_AUDIT_FAILED", { eventId: event.id, code: error.code })
}

/** Marca el evento en Error (sólo desde un estado en curso) con el motivo resumido. */
export async function markEventError(admin: AdminClient, event: CommercialEventRow, phase: "apply" | "restore", raw: string, now: Date) {
  const message = describeExecutionError(raw)
  const { error } = await admin
    .from("product_bulk_events")
    .update({ status: "error", failed_phase: phase, last_error: message, updated_at: now.toISOString() })
    .eq("id", event.id)
    .in("status", ["scheduled", "active"])
  if (error) throw new Error(`No se pudo registrar el error del evento ${event.id}: ${error.message}`)
  await auditExecution(admin, event, phase, now, { result: "error", error: message })
  return message
}

async function applyPriceEvent(admin: AdminClient, event: CommercialEventRow, now: Date): Promise<EventPhaseResult> {
  if (!isBulkPriceActionKind(event.action_kind)) return { ok: false, error: "EVENT_TYPE_MISMATCH" }
  const kind = event.action_kind
  const value = Number(event.value ?? 0)

  const resolved = await resolveBulkTargetProducts(admin, event.scope, normalizeBulkTargetItems(event.target_items))
  if ("error" in resolved) return { ok: false, error: resolved.error }
  if (!resolved.products.length) return { ok: false, error: "EVENT_WITHOUT_PRODUCTS" }

    // Mismo núcleo que el Editor masivo; la RPC verifica que los "antes" sigan vigentes.
  const updates = resolved.products.map((product) => ({
      product_id: product.id,
      before: { precio: product.precio, precio_anterior: product.precio_anterior, descuento: product.descuento },
      after: computeBulkPriceUpdate(product, kind, value),
    }))
  const { data, error } = await admin.rpc("apply_scheduled_price_event", {
      p_event_id: event.id,
      p_updates: updates,
      p_now: now.toISOString(),
    })
  return error ? { ok: false, error: rpcErrorText(error) } : { ok: true, result: (data ?? {}) as Record<string, unknown> }
}

/**
 * Ejecuta UNA fase de un evento (aplicar o restaurar) con la transacción SQL
 * correspondiente. Idempotente: si el evento ya no está en el estado
 * esperado, la RPC no cambia nada ("skipped"). Ante un error, el evento
 * queda en Error con el motivo y NO se reintenta solo.
 */
export async function executeEventPhase(
  admin: AdminClient,
  event: CommercialEventRow,
  phase: "apply" | "restore",
  now: Date,
  { finalStatus = "finished" }: { finalStatus?: "finished" | "cancelled" } = {},
): Promise<EventPhaseResult> {
  let outcome: EventPhaseResult
  if (event.event_type === "financing_policy") {
    const { data, error } = await admin.rpc(
      phase === "apply" ? "apply_financing_policy_event" : "restore_financing_policy_event",
      phase === "apply"
        ? { p_event_id: event.id, p_now: now.toISOString() }
        : { p_event_id: event.id, p_now: now.toISOString(), p_final_status: finalStatus },
    )
    outcome = error ? { ok: false, error: rpcErrorText(error) } : { ok: true, result: (data ?? {}) as Record<string, unknown> }
    // La política global cambió: precios y checkout la leen ya.
    if (outcome.ok) invalidateSiteSettingsCache()
  } else if (phase === "apply") {
    outcome = await applyPriceEvent(admin, event, now)
  } else {
    const { data, error } = await admin.rpc("restore_scheduled_price_event", {
      p_event_id: event.id,
      p_now: now.toISOString(),
      p_final_status: finalStatus,
    })
    outcome = error ? { ok: false, error: rpcErrorText(error) } : { ok: true, result: (data ?? {}) as Record<string, unknown> }
  }

  if (!outcome.ok) {
    console.error("COMMERCIAL_EVENT_EXECUTION_FAILED", { eventId: event.id, phase, error: outcome.error })
    return { ok: false, error: await markEventError(admin, event, phase, outcome.error, now) }
  }
  if (outcome.result.status !== "skipped") await auditExecution(admin, event, phase, now, { result: "ok", ...outcome.result })
  return outcome
}

/**
 * Corrida del scheduler (cron del VPS cada minuto): restaura los eventos
 * vencidos y aplica los que empiezan, en orden. Cada uno es independiente:
 * un error en uno no frena a los demás.
 */
export async function runDueCommercialEvents(admin: AdminClient, now: Date = new Date()) {
  const { data, error } = await admin
    .from("product_bulk_events")
    .select(COMMERCIAL_EVENT_COLUMNS)
    .in("status", ["scheduled", "active"])
    .not("starts_at", "is", null)
  if (error) return { ok: false as const, error: "No se pudieron leer los eventos.", processed: [] }

  return {
    ok: true as const,
    processed: await processDueEventActions(
      (data ?? []) as unknown as CommercialEventRow[],
      now,
      (event, phase) => executeEventPhase(admin, event, phase, now),
      (event, phase, error) => markEventError(admin, event, phase, error, now),
    ),
  }
}

/** Ejecuta en orden y continúa aunque una fase falle; el estado Error lo guarda executeEventPhase. */
export async function processDueEventActions(
  events: readonly CommercialEventRow[],
  now: Date,
  execute: (event: CommercialEventRow, phase: "apply" | "restore") => Promise<EventPhaseResult>,
  onUnexpected: (event: CommercialEventRow, phase: "apply" | "restore", error: string) => Promise<string>,
) {
  const processed: Array<{ id: string; phase: "apply" | "restore"; ok: boolean; error?: string }> = []
  for (const { event, phase } of getDueEventActions(events, now)) {
    try {
      const result = await execute(event, phase)
      processed.push({ id: event.id, phase, ok: result.ok, ...(result.ok ? {} : { error: result.error }) })
    } catch (error) {
      const raw = error instanceof Error ? error.message : "Error inesperado."
      const message = await onUnexpected(event, phase, raw)
      processed.push({ id: event.id, phase, ok: false, error: message })
    }
  }
  return processed
}
