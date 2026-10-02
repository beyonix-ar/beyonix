import { requireInternalUser } from "@/lib/auth/admin-api"
import { findScheduledEventConflict } from "@/lib/commercial-events/conflicts"
import { executeEventPhase } from "@/lib/commercial-events/runner"
import {
  COMMERCIAL_EVENT_COLUMNS,
  isLegacyEvent,
  parseScheduledEventInput,
  type CommercialEventRow,
  type ScheduledEventInput,
} from "@/lib/commercial-events/scheduled-events"
import { computeBulkPriceUpdate, isBulkPriceActionKind } from "@/lib/pricing/bulk-price-engine"
import {
  normalizeBulkTargetItems,
  resolveBulkTargetProducts,
  type BulkTargetProduct,
} from "@/lib/pricing/bulk-price-targets"
import type { createAdminClient } from "@/lib/supabase/admin"

const MANAGE_ROLES = ["admin", "super_admin"] as const

type AdminClient = ReturnType<typeof createAdminClient>

/**
 * Admin → Eventos.
 *
 * - Eventos PROGRAMADOS (con fecha y hora): "Cambio programado de precios"
 *   y "Financiación promocional". Los ejecuta solo el scheduler del VPS
 *   (/api/cron/run-commercial-events); acá se crean, editan (mientras están
 *   programados), cancelan, finalizan antes de tiempo o reintentan.
 * - Eventos MANUALES previos (sin hora): se siguen activando/pausando a mano
 *   como antes, ahora con el mismo núcleo de precios que el Editor masivo.
 */

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

async function loadEvent(admin: AdminClient, id: string) {
  const { data, error } = await admin.from("product_bulk_events").select(COMMERCIAL_EVENT_COLUMNS).eq("id", id).maybeSingle()
  if (error) return { error: "No se pudo leer el evento.", status: 500 }
  if (!data) return { error: "No encontramos el evento.", status: 404 }
  return { event: data as unknown as CommercialEventRow }
}

async function audit(
  auth: { admin: AdminClient; user: { id: string; email?: string | null }; profile: { email?: string | null } },
  action: "INSERT" | "UPDATE" | "DELETE",
  recordId: string,
  beforeData: unknown,
  afterData: Record<string, unknown>,
) {
  const { error } = await auth.admin.from("audit_logs").insert({
    table_name: "product_bulk_events",
    action,
    record_id: recordId,
    actor_user_id: auth.user.id,
    actor_email: auth.user.email ?? auth.profile.email ?? null,
    before_data: beforeData,
    after_data: afterData,
  })
  if (error) console.error("PRODUCT_BULK_EVENT_AUDIT_FAILED", { code: error.code })
}

function scheduledColumns(input: ScheduledEventInput) {
  return {
    internal_name: input.internalName,
    event_type: input.eventType,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    scope: input.scope,
    target_items: input.targetItems,
    action_kind: input.actionKind,
    value: input.value,
    financing_policy: input.financingPolicy,
    starts_on: null,
    duration_days: null,
    installments: null,
  }
}

// ─────────────────────────────────────────────────────────────
// Eventos manuales previos (activar/pausar a mano)
// ─────────────────────────────────────────────────────────────

type ProductSnapshot = {
  id?: unknown
  precio?: unknown
  precio_anterior?: unknown
  descuento?: unknown
  promo_event_id?: unknown
  promo_original_precio?: unknown
  promo_original_precio_anterior?: unknown
  promo_original_descuento?: unknown
}

function toNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function getTodayArgentinaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date())
  const valueFor = (type: string) => parts.find((part) => part.type === type)?.value
  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`
}

async function applyLegacyEvent(admin: AdminClient, event: CommercialEventRow) {
  if (!isBulkPriceActionKind(event.action_kind)) return { error: "Este evento no tiene una acción de precios válida.", status: 400 }
  const kind = event.action_kind
  const resolved = await resolveBulkTargetProducts(admin, event.scope, normalizeBulkTargetItems(event.target_items))
  if ("error" in resolved) return resolved
  const products: BulkTargetProduct[] = resolved.products
  if (!products.length) return { error: "No hay productos para activar el evento.", status: 404 }

  const locked = products.find((product) => product.promo_event_id && product.promo_event_id !== event.id)
  if (locked) return { error: `El producto "${locked.nombre}" ya está tomado por otro evento activo.`, status: 409 }

  const { data: originals, error: originalsError } = await admin
    .from("productos")
    .select("id, precio, precio_anterior, descuento, promo_event_id, promo_original_precio, promo_original_precio_anterior, promo_original_descuento")
    .in("id", products.map((product) => product.id))
  if (originalsError) return { error: "No se pudieron leer los productos.", status: 500 }
  const byId = new Map(((originals ?? []) as ProductSnapshot[]).map((row) => [Number(row.id), row]))

  for (const product of products) {
    const original = byId.get(product.id)
    const ownLock = Boolean(original?.promo_event_id)
    const { error } = await admin
      .from("productos")
      .update({
        // Mismo núcleo que el Editor masivo y los eventos programados.
        ...computeBulkPriceUpdate(product, kind, Number(event.value ?? 0)),
        promo_event_id: event.id,
        promo_original_precio: ownLock ? original?.promo_original_precio ?? product.precio : product.precio,
        promo_original_precio_anterior: ownLock ? original?.promo_original_precio_anterior ?? null : product.precio_anterior,
        promo_original_descuento: ownLock ? original?.promo_original_descuento ?? null : product.descuento,
      })
      .eq("id", product.id)
    if (error) return { error: "No se pudo actualizar un producto del evento.", status: 500 }
  }
  return { affectedCount: products.length, beforeData: products }
}

async function restoreProductSnapshots(admin: AdminClient, snapshot: ProductSnapshot[]) {
  let restoredCount = 0
  for (const product of snapshot) {
    const id = Number(product.id)
    if (!Number.isFinite(id)) continue
    const hasEventLock = Boolean(product.promo_event_id)
    const { error } = await admin
      .from("productos")
      .update({
        precio: hasEventLock ? toNullableNumber(product.promo_original_precio) ?? product.precio ?? null : product.precio ?? null,
        precio_anterior: hasEventLock ? toNullableNumber(product.promo_original_precio_anterior) : product.precio_anterior ?? null,
        descuento: hasEventLock ? toNullableNumber(product.promo_original_descuento) : product.descuento ?? null,
        promo_event_id: null,
        promo_original_precio: null,
        promo_original_precio_anterior: null,
        promo_original_descuento: null,
      })
      .eq("id", id)
    if (error) return { error: "No se pudo restaurar un producto del evento.", status: 500 }
    restoredCount += 1
  }
  return { restoredCount }
}

async function restoreLegacyActivation(admin: AdminClient, event: CommercialEventRow) {
  const { data: lockedProducts, error } = await admin
    .from("productos")
    .select("id, precio, precio_anterior, descuento, promo_event_id, promo_original_precio, promo_original_precio_anterior, promo_original_descuento")
    .eq("promo_event_id", event.id)
  if (error) return { error: "No se pudieron leer los productos del evento.", status: 500 }
  if (lockedProducts?.length) return restoreProductSnapshots(admin, lockedProducts as ProductSnapshot[])

  const { data: logs, error: logsError } = await admin
    .from("audit_logs")
    .select("id, before_data, after_data")
    .eq("table_name", "product_bulk_events")
    .eq("action", "UPDATE")
    .eq("record_id", event.id)
    .order("created_at", { ascending: false })
    .limit(20)
  if (logsError) return { error: "No se pudo leer el historial del evento.", status: 500 }
  const activationLog = (logs ?? []).find(
    (log: { after_data?: { event_type?: unknown } }) => log.after_data?.event_type === "activate",
  )
  const snapshot = activationLog?.before_data
  return Array.isArray(snapshot) && snapshot.length ? restoreProductSnapshots(admin, snapshot as ProductSnapshot[]) : { restoredCount: 0 }
}

async function cleanupLegacyOrphanOffers(admin: AdminClient) {
  const { count, error: eventsError } = await admin.from("product_bulk_events").select("id", { count: "exact", head: true })
  if (eventsError) return { error: "No se pudieron leer los eventos.", status: 500 }
  if ((count ?? 0) > 0) {
    return {
      error: "Todavía hay eventos guardados. Eliminá o editá el evento correspondiente para restaurar sus productos.",
      status: 409,
    }
  }
  const { data: products, error } = await admin
    .from("productos")
    .select("id, precio, precio_anterior, descuento")
    .not("descuento", "is", null)
    .not("precio_anterior", "is", null)
  if (error) return { error: "No se pudieron leer los productos.", status: 500 }
  let cleanedCount = 0
  for (const product of (products ?? []) as Array<{ id: number; precio_anterior: number | null; descuento: number | null }>) {
    if (!product.descuento || !product.precio_anterior) continue
    const { error: updateError } = await admin
      .from("productos")
      .update({
        precio: product.precio_anterior,
        precio_anterior: null,
        descuento: null,
        promo_event_id: null,
        promo_original_precio: null,
        promo_original_precio_anterior: null,
        promo_original_descuento: null,
      })
      .eq("id", product.id)
    if (updateError) return { error: "No se pudo limpiar un producto.", status: 500 }
    cleanedCount += 1
  }
  return { cleanedCount }
}

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const { data, error } = await auth.admin
    .from("product_bulk_events")
    .select(COMMERCIAL_EVENT_COLUMNS)
    .order("created_at", { ascending: false })
  if (error) return Response.json({ error: "No se pudieron cargar los eventos." }, { status: 500 })
  return Response.json({ events: data ?? [] })
}

/** Crea un evento PROGRAMADO (los manuales previos ya no se crean). */
export async function POST(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const parsed = parseScheduledEventInput((await request.json()) as Record<string, unknown>, new Date())
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 })

  const conflict = await findScheduledEventConflict(auth.admin, parsed.value)
  if (conflict && "error" in conflict) return Response.json({ error: conflict.error }, { status: 500 })
  if (conflict) return Response.json({ code: "EVENT_CONFLICT", error: conflict.message }, { status: 409 })

  const { data, error } = await auth.admin
    .from("product_bulk_events")
    .insert({ ...scheduledColumns(parsed.value), status: "scheduled", created_by: auth.user.id, updated_by: auth.user.id })
    .select(COMMERCIAL_EVENT_COLUMNS)
    .single()
  if (error || !data) return Response.json({ error: "No se pudo guardar el evento." }, { status: 500 })

  const event = data as unknown as CommercialEventRow
  await audit(auth, "INSERT", event.id, null, { ...scheduledColumns(parsed.value), commercial_event_type: parsed.value.eventType, event_type: "schedule" })
  return Response.json({ event })
}

export async function PATCH(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const body = (await request.json()) as Record<string, unknown>
  const action = normalizeText(body.action)

  if (action === "cleanup_orphan_offers") {
    const cleaned = await cleanupLegacyOrphanOffers(auth.admin)
    if ("error" in cleaned) return Response.json({ error: cleaned.error }, { status: cleaned.status })
    await audit(auth, "UPDATE", `event-cleanup:${Date.now()}`, null, {
      event_type: "cleanup_orphan_offers",
      cleaned_count: cleaned.cleanedCount,
    })
    return Response.json({ ok: true, cleanedCount: cleaned.cleanedCount })
  }

  const id = normalizeText(body.id)
  if (!id) return Response.json({ error: "Falta el evento." }, { status: 400 })
  const loaded = await loadEvent(auth.admin, id)
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status })
  const event = loaded.event
  const now = new Date()

  // ── Eventos manuales previos ──
  if (isLegacyEvent(event)) {
    if (action === "activate") {
      if (event.status === "active") return Response.json({ error: "Este evento ya está activo." }, { status: 400 })
      if (event.starts_on && event.starts_on > getTodayArgentinaDate()) {
        return Response.json({ error: "Este evento todavía no empieza." }, { status: 400 })
      }
      const applied = await applyLegacyEvent(auth.admin, event)
      if ("error" in applied) return Response.json({ error: applied.error }, { status: applied.status })
      const { data, error } = await auth.admin
        .from("product_bulk_events")
        .update({ status: "active", activated_at: now.toISOString(), updated_by: auth.user.id, updated_at: now.toISOString() })
        .eq("id", id)
        .select(COMMERCIAL_EVENT_COLUMNS)
        .single()
      if (error) return Response.json({ error: "No se pudo activar el evento." }, { status: 500 })
      await audit(auth, "UPDATE", id, applied.beforeData, {
        event_type: "activate",
        event_name: event.internal_name,
        action_kind: event.action_kind,
        affected_count: applied.affectedCount,
      })
      return Response.json({ event: data, affectedCount: applied.affectedCount })
    }
    if (action === "pause") {
      if (event.status !== "active") return Response.json({ error: "Este evento no está activo." }, { status: 400 })
      const restored = await restoreLegacyActivation(auth.admin, event)
      if ("error" in restored) return Response.json({ error: restored.error }, { status: restored.status })
      const { data, error } = await auth.admin
        .from("product_bulk_events")
        .update({ status: "draft", activated_at: null, updated_by: auth.user.id, updated_at: now.toISOString() })
        .eq("id", id)
        .select(COMMERCIAL_EVENT_COLUMNS)
        .single()
      if (error) return Response.json({ error: "No se pudo pausar el evento." }, { status: 500 })
      await audit(auth, "UPDATE", id, { event_name: event.internal_name, status: "active" }, {
        event_type: "pause",
        event_name: event.internal_name,
        status: "draft",
        restored_count: restored.restoredCount,
      })
      return Response.json({ event: data, restoredCount: restored.restoredCount })
    }
    return Response.json({ error: "Los eventos manuales sólo se activan o pausan." }, { status: 400 })
  }

  // ── Eventos programados ──
  if (action === "cancel") {
    if (event.status === "scheduled" || (event.status === "error" && event.failed_phase === "apply")) {
      // Nunca se ejecutó: se cancela sin tocar nada (sólo desde ese estado).
      const { data, error } = await auth.admin
        .from("product_bulk_events")
        .update({ status: "cancelled", cancelled_at: now.toISOString(), updated_by: auth.user.id, updated_at: now.toISOString() })
        .eq("id", id)
        .eq("status", event.status)
        .select(COMMERCIAL_EVENT_COLUMNS)
        .maybeSingle()
      if (error) return Response.json({ error: "No se pudo cancelar el evento." }, { status: 500 })
      if (!data) return Response.json({ error: "El evento cambió de estado. Actualizá la lista." }, { status: 409 })
      await audit(auth, "UPDATE", id, null, { event_type: "cancel", event_name: event.internal_name })
      return Response.json({ event: data })
    }
    if (event.status === "active" && event.ends_at) {
      // Finalizar antes de tiempo: restaura ya (precios exactos / política anterior).
      const result = await executeEventPhase(auth.admin, event, "restore", now, { finalStatus: "cancelled" })
      if (!result.ok) return Response.json({ error: result.error }, { status: 500 })
      await audit(auth, "UPDATE", id, null, { event_type: "finish_early", event_name: event.internal_name })
      const reloaded = await loadEvent(auth.admin, id)
      return Response.json({ event: "event" in reloaded ? reloaded.event : event })
    }
    return Response.json({ error: "Este evento ya no se puede cancelar." }, { status: 400 })
  }

  if (action === "retry") {
    if (event.status !== "error" || !event.failed_phase) {
      return Response.json({ error: "Sólo se reintenta un evento con error." }, { status: 400 })
    }
    // Reintento seguro: cada fase es una transacción, el fallo no dejó cambios a medias.
    const resumeStatus = event.failed_phase === "apply" ? "scheduled" : "active"
    const { data: resumed, error } = await auth.admin
      .from("product_bulk_events")
      .update({ status: resumeStatus, updated_by: auth.user.id, updated_at: now.toISOString() })
      .eq("id", id)
      .eq("status", "error")
      .select(COMMERCIAL_EVENT_COLUMNS)
      .maybeSingle()
    if (error) return Response.json({ error: "No se pudo reintentar el evento." }, { status: 500 })
    if (!resumed) return Response.json({ error: "El evento cambió de estado. Actualizá la lista." }, { status: 409 })
    await audit(auth, "UPDATE", id, null, { event_type: "retry", phase: event.failed_phase, event_name: event.internal_name })
    const result = await executeEventPhase(auth.admin, resumed as unknown as CommercialEventRow, event.failed_phase, now)
    const reloaded = await loadEvent(auth.admin, id)
    const current = "event" in reloaded ? reloaded.event : event
    return result.ok ? Response.json({ event: current }) : Response.json({ error: result.error, event: current }, { status: 500 })
  }

  if (action) return Response.json({ error: "Acción no válida." }, { status: 400 })

  // Edición: sólo mientras está programado (lo ejecutado queda en el historial).
  if (event.status !== "scheduled") {
    return Response.json({ error: "Sólo se edita un evento programado que todavía no empezó." }, { status: 400 })
  }
  const parsed = parseScheduledEventInput(body, now)
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 })
  const conflict = await findScheduledEventConflict(auth.admin, parsed.value, id)
  if (conflict && "error" in conflict) return Response.json({ error: conflict.error }, { status: 500 })
  if (conflict) return Response.json({ code: "EVENT_CONFLICT", error: conflict.message }, { status: 409 })

  const { data, error } = await auth.admin
    .from("product_bulk_events")
    .update({ ...scheduledColumns(parsed.value), updated_by: auth.user.id, updated_at: now.toISOString() })
    .eq("id", id)
    .eq("status", "scheduled")
    .select(COMMERCIAL_EVENT_COLUMNS)
    .maybeSingle()
  if (error) return Response.json({ error: "No se pudo guardar el evento." }, { status: 500 })
  if (!data) return Response.json({ error: "El evento ya empezó. Actualizá la lista." }, { status: 409 })
  await audit(auth, "UPDATE", id, null, { ...scheduledColumns(parsed.value), commercial_event_type: parsed.value.eventType, event_type: "edit_schedule" })
  return Response.json({ event: data })
}

export async function DELETE(request: Request) {
  const auth = await requireInternalUser(request, [...MANAGE_ROLES])
  if ("error" in auth) return auth.error

  const id = normalizeText(new URL(request.url).searchParams.get("id"))
  if (!id) return Response.json({ error: "Falta el evento." }, { status: 400 })
  const loaded = await loadEvent(auth.admin, id)
  if ("error" in loaded) return Response.json({ error: loaded.error }, { status: loaded.status })
  const event = loaded.event

  let restoredCount = 0
  if (isLegacyEvent(event)) {
    const restored = await restoreLegacyActivation(auth.admin, event)
    if ("error" in restored) return Response.json({ error: restored.error }, { status: restored.status })
    restoredCount = restored.restoredCount
  } else if (event.executed_at || !["scheduled", "cancelled", "error"].includes(event.status)) {
    // Lo que se ejecutó queda en el historial (snapshot y auditoría).
    return Response.json({ error: "Un evento que ya se ejecutó queda en el historial. Podés cancelarlo o finalizarlo." }, { status: 409 })
  }

  const { error } = await auth.admin.from("product_bulk_events").delete().eq("id", id)
  if (error) return Response.json({ error: "No se pudo eliminar el evento." }, { status: 500 })
  await audit(auth, "DELETE", id, null, {
    event_type: "delete_event",
    event_name: event.internal_name,
    restored_count: restoredCount,
  })
  return Response.json({ ok: true, restoredCount })
}
