import assert from "node:assert/strict"
import test from "node:test"

import { processDueEventActions } from "./runner.ts"
import type { CommercialEventRow } from "./scheduled-events.ts"

const NOW = new Date("2026-10-05T06:00:00.000Z")

function event(id: string, status: "scheduled" | "active" | "error", startsAt: string, endsAt: string | null): CommercialEventRow {
  return {
    id,
    internal_name: id,
    event_type: "financing_policy",
    status,
    starts_on: null,
    duration_days: null,
    starts_at: startsAt,
    ends_at: endsAt,
    scope: "store",
    target_items: [],
    action_kind: null,
    value: null,
    financing_policy: "same_as_cash",
    previous_financing_policy: null,
    executed_at: null,
    restored_at: null,
    cancelled_at: null,
    failed_phase: null,
    last_error: null,
    result: null,
    activated_at: null,
    created_by: null,
    updated_by: null,
    created_at: startsAt,
    updated_at: startsAt,
  }
}

test("runner: restaura antes de aplicar y un error no impide ejecutar el siguiente evento", async () => {
  const calls: string[] = []
  const errors: string[] = []
  const processed = await processDueEventActions([
    event("apply-later", "scheduled", "2026-10-05T05:30:00.000Z", "2026-10-06T06:00:00.000Z"),
    event("b-same-time", "scheduled", "2026-10-05T05:45:00.000Z", null),
    event("restore-first", "active", "2026-10-03T05:00:00.000Z", "2026-10-05T05:59:00.000Z"),
    event("apply-first", "scheduled", "2026-10-05T05:00:00.000Z", "2026-10-06T06:00:00.000Z"),
    event("a-same-time", "scheduled", "2026-10-05T05:45:00.000Z", null),
    event("future", "scheduled", "2026-10-05T07:00:00.000Z", "2026-10-06T06:00:00.000Z"),
    event("error", "error", "2026-10-05T05:00:00.000Z", null),
  ], NOW, async (item, phase) => {
    calls.push(`${phase}:${item.id}`)
    if (item.id === "apply-first") throw new Error("falló la fase")
    return { ok: true, result: { status: "applied" } }
  }, async (item, phase, raw) => {
    errors.push(`${phase}:${item.id}:${raw}`)
    return "Error registrado"
  })
  assert.deepEqual(calls, ["restore:restore-first", "apply:apply-first", "apply:apply-later", "apply:a-same-time", "apply:b-same-time"])
  assert.deepEqual(errors, ["apply:apply-first:falló la fase"])
  assert.deepEqual(processed.map((item) => [item.id, item.ok]), [
    ["restore-first", true], ["apply-first", false], ["apply-later", true], ["a-same-time", true], ["b-same-time", true],
  ])
})
