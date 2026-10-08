import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  INCOMPLETE_CHECKOUT_PAYMENT_STATUS,
  deleteIncompleteCheckoutOrder,
} from "./checkout-inventory.ts"

// Fase 6: un pedido de checkout que falla DESPUÉS de insertarse (débito de
// saldo, vínculo del beneficio, confirmación) nunca puede quedar vivo,
// pagable ni bloqueando la misma compra.

type Row = { id: number; estado: string; payment_status?: string; financial_status?: string }

function fakeAdmin(order: Row | null, options: { orderDeleteFails?: boolean; cancelFails?: boolean } = {}) {
  const state = { order: order ? { ...order } : null, itemsDeleted: false, ops: [] as string[] }
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      let op: "select" | "delete" | "update" = "select"
      let patch: Record<string, unknown> = {}
      const matches = () =>
        state.order !== null &&
        Object.entries(filters).every(([key, value]) => (state.order as Record<string, unknown>)[key] === value)
      const builder = {
        select() { return builder },
        delete() { op = "delete"; return builder },
        update(values: Record<string, unknown>) { op = "update"; patch = values; return builder },
        eq(column: string, value: unknown) {
          if (table === "ordenes") filters[column === "id" ? "id" : column] = value
          return builder
        },
        async maybeSingle() {
          state.ops.push(`${table}:${op}`)
          if (op === "select") return { data: matches() ? { id: state.order!.id } : null, error: null }
          if (op === "delete") {
            if (options.orderDeleteFails) return { data: null, error: { message: "violates foreign key constraint" } }
            if (!matches()) return { data: null, error: null }
            const id = state.order!.id
            state.order = null
            return { data: { id }, error: null }
          }
          if (options.cancelFails) return { data: null, error: { message: "connection reset" } }
          if (!matches()) return { data: null, error: null }
          state.order = { ...state.order!, ...patch }
          return { data: { id: state.order.id }, error: null }
        },
        then(resolve: (value: { error: null }) => void) {
          // orden_items.delete().eq(...) se espera sin maybeSingle.
          state.ops.push(`${table}:${op}`)
          if (table === "orden_items") state.itemsDeleted = true
          resolve({ error: null })
        },
      }
      return builder
    },
  }
  return { client, state }
}

test("pedido pendiente sin referencias: se borra junto con sus ítems", async () => {
  const { client, state } = fakeAdmin({ id: 7, estado: "pendiente" })
  assert.equal(await deleteIncompleteCheckoutOrder(client as never, 7), "deleted")
  assert.equal(state.order, null)
  assert.equal(state.itemsDeleted, true)
})

test("si el DELETE falla (movimientos de saldo/auditoría lo referencian) se cancela: nunca queda pagable", async () => {
  const { client, state } = fakeAdmin({ id: 7, estado: "pendiente" }, { orderDeleteFails: true })
  assert.equal(await deleteIncompleteCheckoutOrder(client as never, 7), "cancelled")
  assert.equal(state.order?.estado, "cancelado")
  assert.equal(state.order?.payment_status, INCOMPLETE_CHECKOUT_PAYMENT_STATUS)
  assert.equal(state.order?.financial_status, "cancelled")
})

test("nunca toca un pedido que ya no está pendiente (p. ej. pagado por una carrera)", async () => {
  const { client, state } = fakeAdmin({ id: 7, estado: "pagado" })
  assert.equal(await deleteIncompleteCheckoutOrder(client as never, 7), "not_pending")
  assert.equal(state.order?.estado, "pagado")
  assert.deepEqual(state.ops, ["ordenes:select"])
})

test("si tampoco se puede cancelar, lo informa (no lo oculta)", async () => {
  const { client } = fakeAdmin({ id: 7, estado: "pendiente" }, { orderDeleteFails: true, cancelFails: true })
  const original = console.error
  const logged: unknown[] = []
  console.error = (...args: unknown[]) => { logged.push(args[0]) }
  try {
    assert.equal(await deleteIncompleteCheckoutOrder(client as never, 7), "failed")
  } finally {
    console.error = original
  }
  assert.deepEqual(logged, ["INCOMPLETE_CHECKOUT_ORDER_CLEANUP_FAILED"])
})

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  assert.ok(from >= 0, `no se encontró ${start}`)
  return source.slice(from, source.indexOf(end, from + start.length))
}

test("saldo a favor: el beneficio se vincula ANTES de confirmar y, una vez pagado, nada se revierte", () => {
  const route = read("app/api/customer-credit/create-order/route.ts")
  const body = between(route, "await applyCustomerCreditToOrder(admin, {", "return NextResponse.json({\n      order_id")
  assert.ok(body.indexOf("linkStoreBenefitToOrder") < body.indexOf('estado: "pagado"'))
  assert.match(body, /\.eq\("estado", "pendiente"\)\s*\.select\("id"\)\s*\.maybeSingle\(\)/)
  assert.match(body, /orderId = null\s*creditApplied = false\s*benefitLinkedOrderId = null\s*claimedBenefitId = null/)
  assert.ok(body.indexOf("orderId = null") < body.indexOf("appendOrderAuditEvent"))
  const cleanup = between(route, "} catch (error) {", "console.error(\"CUSTOMER_CREDIT_CREATE_ORDER_ERROR\"")
  assert.match(cleanup, /reverseCustomerCreditForOrder/)
  assert.match(cleanup, /restoreStoreBenefitFromSupersededOrder/)
  assert.match(cleanup, /if \(orderId\) \{\s*await deleteIncompleteCheckoutOrder\(admin, orderId\)/)
  assert.match(route, /INSUFFICIENT_CUSTOMER_CREDIT[\s\S]*CUSTOMER_CREDIT_CHANGED_MESSAGE[\s\S]*status: 409/)
})

test("transferencia: un fallo al debitar saldo o vincular el beneficio retira el pedido (nunca queda pagable por menos)", () => {
  const route = read("app/api/transferencia/create-order/route.ts")
  const body = between(route, "incompleteOrderId = order.id", "await sendOrderStatusEmail")
  assert.match(body, /creditDebitedOrderId = order\.id/)
  assert.match(body, /benefitLinkedOrderId = order\.id/)
  assert.match(body, /incompleteOrderId = null\s*creditDebitedOrderId = null\s*benefitLinkedOrderId = null\s*claimedBenefitId = null/)
  const cleanup = between(route, "console.error(\"TRANSFER_CREATE_ORDER_ERROR\"", "if (error instanceof InsufficientStockError)")
  assert.ok(cleanup.indexOf("reverseCustomerCreditForOrder") < cleanup.indexOf("deleteIncompleteCheckoutOrder"))
  assert.match(cleanup, /restoreStoreBenefitFromSupersededOrder/)
  assert.match(route, /INSUFFICIENT_CUSTOMER_CREDIT/)
})

test("Mercado Pago: saldo consumido por otra pestaña se informa como conflicto, no como error técnico", () => {
  const route = read("app/api/mercadopago/create-preference/route.ts")
  assert.match(route, /INSUFFICIENT_CUSTOMER_CREDIT[\s\S]*El saldo a favor disponible cambió[\s\S]*status: 409/)
})
