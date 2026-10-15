import assert from "node:assert/strict"
import test from "node:test"

import { classifyMercadoPagoRefundOrigin, getUnknownMercadoPagoRefunds, hasMercadoPagoRefundSignal } from "./refund-origin.ts"

// Comparación por conjuntos: REFUNDS QUE INFORMA MP vs REFUNDS DE BEYONIX.
const confirmed = (mp_refund_id: string | null, amount: number) => ({ status: "confirmed", mp_refund_id, amount })
const keys = (unknown: ReturnType<typeof getUnknownMercadoPagoRefunds>) => unknown.map((refund) => [refund.key, refund.amount])

test("A. refund creado por BEYONIX (pedidos #2 y #4): propio, sin incidente", () => {
  const payment = { refunds: [{ id: 3442447402, amount: 1000, status: "approved" }], transaction_amount_refunded: 1000 }
  assert.deepEqual(getUnknownMercadoPagoRefunds(182996233611, payment, [confirmed("3442447402", 1000)]), [])
  assert.equal(classifyMercadoPagoRefundOrigin(payment, [{ mp_refund_id: "3442447402", amount: "1000.00" }]), "beyonix")
})

test("B. refund externo total: incidente por el total", () => {
  const unknown = getUnknownMercadoPagoRefunds(1, { refunds: [{ id: 900, amount: 1000 }], transaction_amount_refunded: 1000 }, [])
  assert.deepEqual(keys(unknown), [["mp_refund:900", 1000]])
})

test("C. refund externo PARCIAL con el pago todavía 'approved': incidente por el parcial", () => {
  const payment = { refunds: [{ id: 901, amount: 250.5 }], transaction_amount_refunded: 250.5 }
  assert.equal(hasMercadoPagoRefundSignal(payment), true, "no depende de payment.status")
  assert.deepEqual(keys(getUnknownMercadoPagoRefunds(1, payment, [])), [["mp_refund:901", 250.5]])
})

test("D. BEYONIX devolvió $70.000 y aparecen otros $10.000: sólo se alertan los $10.000", () => {
  const payment = { refunds: [{ id: 555, amount: 70000 }, { id: 777, amount: 10000 }], transaction_amount_refunded: 80000 }
  assert.deepEqual(keys(getUnknownMercadoPagoRefunds(1, payment, [confirmed("555", 70000)])), [["mp_refund:777", 10000]])
})

test("E. varios refunds parciales: se compara el conjunto, no el estado ni el total", () => {
  const payment = {
    refunds: [{ id: 1, amount: 100 }, { id: 2, amount: 200 }, { id: 3, amount: 300 }, { id: 4, amount: 50, status: "rejected" }],
    transaction_amount_refunded: 600,
  }
  assert.deepEqual(keys(getUnknownMercadoPagoRefunds(1, payment, [confirmed("2", 200)])), [["mp_refund:1", 100], ["mp_refund:3", 300]],
    "un refund rechazado por MP no movió dinero")
})

test("respuesta perdida / webhook tardío: un intento propio sin id reclama el refund de su importe", () => {
  const payment = { refunds: [{ id: 555, amount: 70000 }], transaction_amount_refunded: 70000 }
  for (const status of ["processing", "needs_reconciliation", "confirmed"]) {
    assert.deepEqual(getUnknownMercadoPagoRefunds(1, payment, [{ status, mp_refund_id: null, amount: "70000.00" }]), [], status)
  }
  // Un intento fallido nunca devolvió dinero: no reclama nada.
  assert.deepEqual(keys(getUnknownMercadoPagoRefunds(1, payment, [{ status: "failed", mp_refund_id: null, amount: 70000 }])), [["mp_refund:555", 70000]])
  // Un intento sin id reclama sólo UN refund de su importe; el segundo igual es externo.
  const twice = { refunds: [{ id: 8, amount: 500 }, { id: 9, amount: 500 }], transaction_amount_refunded: 1000 }
  assert.deepEqual(keys(getUnknownMercadoPagoRefunds(1, twice, [{ status: "processing", mp_refund_id: null, amount: 500 }])), [["mp_refund:9", 500]])
})

test("webhook repetido / duplicado en la lista de MP: la clave es estable y el refund se cuenta una vez", () => {
  const payment = { refunds: [{ id: 901, amount: 300 }, { id: "901", amount: 300 }], transaction_amount_refunded: 300 }
  const first = getUnknownMercadoPagoRefunds(1, payment, [])
  assert.deepEqual(keys(first), [["mp_refund:901", 300]])
  assert.deepEqual(keys(getUnknownMercadoPagoRefunds(1, payment, [])), keys(first), "misma clave en cada entrega")
})

test("sin detalle de refunds: sólo el excedente sobre lo propio, y nunca dos veces", () => {
  assert.deepEqual(getUnknownMercadoPagoRefunds(77, { transaction_amount_refunded: 1000 }, [confirmed(null, 1000)]), [])
  const first = getUnknownMercadoPagoRefunds(77, { transaction_amount_refunded: 1000 }, [confirmed(null, 600)])
  assert.deepEqual(keys(first), [["mp_refund_total:77:100000", 400]])
  // Más tarde MP informa $1.500 devueltos: sólo los $500 nuevos.
  assert.deepEqual(keys(getUnknownMercadoPagoRefunds(77, { transaction_amount_refunded: 1500 }, [confirmed(null, 600)], 400)),
    [["mp_refund_total:77:150000", 500]])
})

test("compatibilidad: id desconocido sin importe sigue siendo externo", () => {
  assert.equal(classifyMercadoPagoRefundOrigin({ refunds: [{ id: "777" }] }, [{ mp_refund_id: "3442447402", amount: 1000 }]), "external")
  assert.equal(classifyMercadoPagoRefundOrigin({ transaction_amount_refunded: 1000 }, [{ mp_refund_id: null, amount: 600 }]), "external")
  assert.equal(hasMercadoPagoRefundSignal({ refunds: [], transaction_amount_refunded: 0 }), false)
})
