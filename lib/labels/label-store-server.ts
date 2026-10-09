import type { SupabaseClient } from "@supabase/supabase-js"

import {
  LABEL_HISTORY_LIMIT,
  parseBatchItems,
  parseBatchOutput,
  type LabelBatchItem,
  type LabelBatchOutput,
  type LabelBatchSummary,
  type LabelPreset,
} from "./history.ts"
import { normalizeLabelSettings, type LabelSettings } from "./settings.ts"

type DbError = { message: string; code?: string } | null

// Sin la migración 20261009150000_label_printing.sql el módulo sigue
// funcionando (cola y configuración locales); sólo se informa.
export class LabelStorageUnavailableError extends Error {}
export class LabelPresetConflictError extends Error {}

function check<T>({ data, error }: { data: T | null; error: DbError }): T | null {
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205" || /label_print_/.test(error.message)) throw new LabelStorageUnavailableError(error.message)
    if (error.code === "23505") throw new LabelPresetConflictError("Ya existe un preset con ese nombre.")
    throw new Error(error.message)
  }
  return data
}

function checkRow<T>(result: { data: T | null; error: DbError }): T {
  const row = check(result)
  if (!row) throw new Error("La base no devolvió el registro guardado.")
  return row
}

type PresetRow = { id: string; name: string; settings: unknown; updated_at: string }
type BatchRow = { id: string; name: string; items: unknown; label_count: number; output: string; created_at: string }

const toPreset = (row: PresetRow): LabelPreset => ({ id: row.id, name: row.name, settings: normalizeLabelSettings(row.settings), updatedAt: row.updated_at })

function toBatch(row: BatchRow): LabelBatchSummary | null {
  const items = parseBatchItems(row.items)
  const output = parseBatchOutput(row.output)
  return items && output ? { id: row.id, name: row.name, labelCount: row.label_count, output, createdAt: row.created_at, items } : null
}

export async function loadLabelConfig(admin: SupabaseClient, userId: string) {
  const [presets, preference, batches] = await Promise.all([
    admin.from("label_print_presets").select("id, name, settings, updated_at").order("name"),
    admin.from("label_print_preferences").select("settings").eq("user_id", userId).maybeSingle(),
    admin.from("label_print_batches").select("id, name, items, label_count, output, created_at").order("created_at", { ascending: false }).limit(LABEL_HISTORY_LIMIT),
  ])
  const preferenceRow = check<{ settings: unknown } | null>(preference)
  return {
    presets: (check<PresetRow[] | null>(presets) ?? []).map(toPreset),
    preference: preferenceRow ? normalizeLabelSettings(preferenceRow.settings) : null,
    batches: (check<BatchRow[] | null>(batches) ?? []).flatMap((row) => toBatch(row) ?? []),
  }
}

export async function saveLabelPreference(admin: SupabaseClient, userId: string, settings: LabelSettings) {
  check(await admin.from("label_print_preferences").upsert({ user_id: userId, settings, updated_at: new Date().toISOString() }, { onConflict: "user_id" }))
}

export async function saveLabelPreset(admin: SupabaseClient, userId: string, input: { name: string; settings: LabelSettings; overwrite: boolean }) {
  const existing = check<{ id: string } | null>(
    await admin.from("label_print_presets").select("id").ilike("name", input.name.replace(/[\\%_]/g, (character) => `\\${character}`)).maybeSingle(),
  )
  if (existing && !input.overwrite) throw new LabelPresetConflictError("Ya existe un preset con ese nombre.")
  const now = new Date().toISOString()
  const row = existing
    ? checkRow<PresetRow>(await admin.from("label_print_presets").update({ name: input.name, settings: input.settings, updated_at: now }).eq("id", existing.id).select("id, name, settings, updated_at").single())
    : checkRow<PresetRow>(await admin.from("label_print_presets").insert({ name: input.name, settings: input.settings, created_by: userId }).select("id, name, settings, updated_at").single())
  return toPreset(row)
}

export async function deleteLabelPreset(admin: SupabaseClient, id: string) {
  check(await admin.from("label_print_presets").delete().eq("id", id))
}

export async function saveLabelBatch(
  admin: SupabaseClient,
  userId: string,
  input: { name: string; items: LabelBatchItem[]; labelCount: number; output: LabelBatchOutput },
) {
  const row = checkRow<BatchRow>(
    await admin
      .from("label_print_batches")
      .insert({ name: input.name, items: input.items, label_count: input.labelCount, output: input.output, created_by: userId })
      .select("id, name, items, label_count, output, created_at")
      .single(),
  )
  return toBatch(row)
}
