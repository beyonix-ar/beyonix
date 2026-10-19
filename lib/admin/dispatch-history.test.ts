import assert from "node:assert/strict"
import test from "node:test"
import { getDispatchHistory } from "./dispatch-history"
import type { DispatchAdmin } from "./dispatch"

test("el historial atribuye Picking, Armado, Control y Confirmación a sus actores reales", async () => {
  type Row = Record<string, unknown>
  const rows: Record<string, Row[]> = {
    dispatch_batches: [{ id: 7, code: "DSP-7", display_number: 7, status: "handed_over", created_at: "2026-10-18T09:00:00Z", closed_at: "2026-10-18T12:00:00Z", handed_over_at: "2026-10-18T15:24:00Z", created_by: "assembler", closed_by: "closer", handed_over_by: "confirmer" }],
    dispatch_batch_items: [
      { batch_id: 7, order_id: 12, package_id: 112, removed_at: null, removal_reason: null, removed_by: null, verified_by: "controller" },
      { batch_id: 7, order_id: 13, package_id: 113, removed_at: "2026-10-18T13:00:00Z", removal_reason: "Pedido cancelado", removed_by: "remover", verified_by: null },
    ],
    order_packages: [{ id: 112, parcel_count: 2, prepared_by: "preparer", attempt_number: 2 }, { id: 113, parcel_count: 1, prepared_by: "preparer", attempt_number: 1 }],
    ordenes: [{ id: 12, cancelled_at: null }, { id: 13, cancelled_at: "2026-10-18T13:00:00Z" }],
    order_preparation_scans: [{ id: 1, package_id: 112, attempt_number: 1, scanned_by: "old-picker" }, { id: 2, package_id: 112, attempt_number: 2, scanned_by: "picker" }, { id: 3, package_id: 113, attempt_number: 1, scanned_by: "removed-picker" }],
    profiles: ["picker", "old-picker", "removed-picker", "preparer", "assembler", "closer", "controller", "confirmer", "remover"].map((id) => ({ id, nombre: id, username: id, email: `${id}@test.invalid` })),
  }
  const admin = { from(table: string) {
    let result = rows[table] ?? []
    const query = {
      select() { return query },
      eq(column: string, value: unknown) { result = result.filter((row) => row[column] === value); return query },
      in(column: string, values: readonly unknown[]) { result = result.filter((row) => values.includes(row[column])); return query },
      order() { return query },
      range(from: number, to: number) { result = result.slice(from, to + 1); return query },
      maybeSingle() { return Promise.resolve({ data: result[0] ?? null, error: null }) },
      then(resolve: (value: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: result, error: null }).then(resolve) },
    }
    return query
  } } as unknown as DispatchAdmin
  const history = await getDispatchHistory(admin, 7)
  assert.ok(history)
  assert.deepEqual(history.pickingBy, ["picker"])
  assert.deepEqual(history.preparedBy, ["preparer"])
  assert.equal(history.assembledBy, "assembler")
  assert.deepEqual(history.controlledBy, ["controller"])
  assert.equal(history.deliveredBy, "confirmer")
  assert.equal(history.orderCount, 1)
  assert.equal(history.parcelCount, 2)
  assert.equal(history.items[1]?.removedBy, "remover")
})
