import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  formatReservationDeadline,
  getCustomerTransferReservationState,
} from "./transfer-reservation-display.ts"
import { attachTransferReservationDeadlines } from "./transfer-reservation-window.ts"
import { getPaymentProgressLabel } from "../account/account-utils.ts"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const at = (time: string) => Date.parse(`2026-09-26T${time}:00.000-03:00`)
const pending = {
  estado: "pendiente",
  payment_method_id: "transferencia",
  payment_status: "pendiente_comprobante",
  payment_proof_url: null,
  payment_proof_uploaded_at: null,
  transfer_reservation_expires_at: new Date(at("10:20")).toISOString(),
}

test("P3: pago pendiente con la reserva vigente -> hora de vencimiento y tiempo restante", () => {
  const state = getCustomerTransferReservationState(pending, at("10:15"))
  assert.equal(state.kind, "active")
  if (state.kind !== "active") return
  assert.equal(state.secondsLeft, 300)
  assert.equal(formatReservationDeadline(state.expiresAt), "10:20")
})

test("P3: vencida, sin reserva registrada o con fecha inválida -> Reserva vencida (nunca stock garantizado de más)", () => {
  assert.equal(getCustomerTransferReservationState(pending, at("10:20")).kind, "expired")
  assert.equal(getCustomerTransferReservationState(pending, at("11:00")).kind, "expired")
  assert.equal(getCustomerTransferReservationState({ ...pending, transfer_reservation_expires_at: null }, at("10:00")).kind, "expired")
  assert.equal(getCustomerTransferReservationState({ ...pending, transfer_reservation_expires_at: "x" }, at("10:00")).kind, "expired")
})

test("P3: sólo aplica a transferencias que esperan el pago", () => {
  for (const overrides of [
    { payment_method_id: "mercadopago" },
    { estado: "pagado", payment_status: "confirmado" },
    { payment_status: "en_revision" },
    { payment_proof_url: "proofs/1.pdf" },
    { estado: "cancelado", payment_status: "checkout_superseded" },
    { payment_status: "auto_verified_stock_conflict" },
  ]) {
    assert.equal(getCustomerTransferReservationState({ ...pending, ...overrides }, at("10:05")).kind, "none", JSON.stringify(overrides))
  }
  assert.equal(getPaymentProgressLabel(pending as never), "Pago pendiente")
  assert.equal(
    getPaymentProgressLabel({ ...pending, estado: "cancelado", payment_status: "approved_after_cancellation" } as never),
    "Pago recibido tras cancelar (en revisión)",
  )
})

test("P3: el servidor adjunta el vencimiento ORIGINAL en una sola consulta y sólo a pedidos que esperan el pago", async () => {
  const queries: Array<{ table: string; filters: unknown[][] }> = []
  const admin = {
    from(table: string) {
      const query = { table, filters: [] as unknown[][] }
      queries.push(query)
      const chain = {
        select: () => chain,
        in: (...args: unknown[]) => {
          query.filters.push(["in", ...args])
          return Promise.resolve({
            data: [
              { order_id: 1, expires_at: "2026-09-26T13:20:00.000Z" },
              { order_id: "1", expires_at: "2026-09-26T13:10:00.000Z" },
            ],
            error: null,
          })
        },
      }
      return chain
    },
  }
  const base = {
    estado: "pendiente",
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    payment_proof_url: null,
    payment_proof_uploaded_at: null,
  }
  const orders = [
    { id: 1, ...base },
    { id: 2, ...base },
    { id: 3, ...base, payment_method_id: "mercadopago" },
    { id: 4, ...base, estado: "pagado", payment_status: "confirmado" },
  ]

  const result = await attachTransferReservationDeadlines(admin as never, orders)
  assert.equal(queries.length, 1)
  assert.equal(queries[0].table, "checkout_reservation_sessions")
  assert.deepEqual(queries[0].filters, [["in", "order_id", [1, 2]]])
  assert.equal(result[0].transfer_reservation_expires_at, "2026-09-26T13:20:00.000Z")
  assert.equal(result[1].transfer_reservation_expires_at, null, "sin reserva registrada")
  assert.equal("transfer_reservation_expires_at" in result[2], false)
  assert.equal("transfer_reservation_expires_at" in result[3], false)

  // Sin pedidos que esperen el pago no hay consulta.
  const untouched = await attachTransferReservationDeadlines(admin as never, [orders[3]])
  assert.equal(queries.length, 1)
  assert.deepEqual(untouched, [orders[3]])
})

test("P3: Mis compras muestra el aviso, usa la hora del servidor y nunca abre ni renueva una reserva", () => {
  const notice = read("../../components/account/transfer-reservation-notice.tsx")
  assert.match(notice, /stock reservado hasta las \{formatReservationDeadline\(state\.expiresAt\)\}/)
  assert.match(notice, /Reserva vencida\./)
  assert.match(notice, /iniciá una compra nueva desde tu carrito/)
  assert.doesNotMatch(notice, /fetch\(|reserveCartStock|reserve_cart_stock|commit_/)

  const list = read("../../components/account/account-orders.tsx")
  assert.match(list, /setServerNow\(data\.server_now \?\? null\)/)
  assert.match(list, /<TransferReservationNotice order=\{order\} serverNow=\{serverNow\}/)

  const detail = read("../../app/cuenta/cuenta-client.tsx")
  assert.match(detail, /<TransferReservationNotice order=\{order\} serverNow=\{serverNow\}/)
  assert.match(detail, /\{!transferReservationExpired && \(\s*<Link\s*href=\{`\/checkout\/success\?method=transferencia/)

  for (const route of ["../../app/api/orders/route.ts", "../../app/api/orders/[id]/route.ts"]) {
    const source = read(route)
    assert.match(source, /attachTransferReservationDeadlines\(admin,/)
    assert.match(source, /server_now: new Date\(\)\.toISOString\(\)/)
  }
})
