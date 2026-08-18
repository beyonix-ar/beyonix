import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import test from "node:test"

// Contrato de orden cronológico: si alguna migración consume (SELECT/INSERT/
// UPDATE/DELETE/FK) order_credit_notes u order_credit_note_items ANTES de la
// migración que las crea, una reconstrucción desde una base vacía rompe ahí
// (por ejemplo, un DELETE contra una tabla todavía inexistente). Esto ya
// pasó una vez: 20260816140000_reset_commercial_test_data.sql hacía DELETE
// sobre estas tablas mientras su formalización estaba fechada 20260818100000
// (más tarde). Se corrigió reubicando esa formalización inmediatamente
// después del baseline (20260729181537_remote_schema.sql), porque las
// tablas reales se crearon a mano el 2026-07-27, antes de que
// supabase/migrations/ empezara a versionar cambios. Este test evita que
// la inconsistencia se reintroduzca sin que alguien lo note.

const MIGRATIONS_DIR = new URL("../../supabase/migrations/", import.meta.url)

function loadMigrationsInOrder() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"),
    }))
}

const TABLES = [
  {
    table: "order_credit_notes",
    creates: /create table if not exists public\.order_credit_notes\s*\(/i,
    consumes:
      /\b(from|into|update|references)\s+public\.order_credit_notes\b/i,
  },
  {
    table: "order_credit_note_items",
    creates: /create table if not exists public\.order_credit_note_items\s*\(/i,
    consumes:
      /\b(from|into|update|references)\s+public\.order_credit_note_items\b/i,
  },
]

test("order_credit_notes/order_credit_note_items se crean antes que cualquier migración que las consuma", () => {
  const migrations = loadMigrationsInOrder()
  assert.ok(migrations.length > 0, "no se encontraron migraciones")

  for (const { table, creates, consumes } of TABLES) {
    const creatorIndex = migrations.findIndex((m) => creates.test(m.sql))
    assert.notEqual(
      creatorIndex,
      -1,
      `ninguna migración crea ${table} (create table if not exists public.${table})`,
    )

    const consumersBeforeCreation = migrations
      .slice(0, creatorIndex)
      .filter((m) => consumes.test(m.sql))
      .map((m) => m.name)

    assert.deepEqual(
      consumersBeforeCreation,
      [],
      `${table} se crea en ${migrations[creatorIndex].name}, pero estas migraciones anteriores ya la consumen: ${consumersBeforeCreation.join(", ")}`,
    )
  }
})

test("la formalización de order_credit_notes queda inmediatamente después del baseline, antes del reset de datos de prueba", () => {
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()

  const baselineIndex = names.indexOf("20260729181537_remote_schema.sql")
  const formalizeIndex = names.indexOf(
    "20260729181538_formalize_partial_credit_notes.sql",
  )
  const formalizeReturnsIndex = names.indexOf(
    "20260729181539_formalize_credit_note_return_management.sql",
  )
  const resetIndex = names.indexOf(
    "20260816140000_reset_commercial_test_data.sql",
  )

  assert.notEqual(baselineIndex, -1, "falta el baseline 20260729181537")
  assert.notEqual(formalizeIndex, -1, "falta 20260729181538 (formaliza 091)")
  assert.notEqual(
    formalizeReturnsIndex,
    -1,
    "falta 20260729181539 (formaliza 092)",
  )
  assert.notEqual(resetIndex, -1, "falta 20260816140000_reset_commercial_test_data.sql")

  assert.ok(baselineIndex < formalizeIndex)
  assert.ok(formalizeIndex < formalizeReturnsIndex)
  assert.ok(formalizeReturnsIndex < resetIndex)
})
