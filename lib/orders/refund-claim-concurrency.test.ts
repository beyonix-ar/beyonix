import assert from "node:assert/strict"
import test from "node:test"

/**
 * Simula el mismo patrón compare-and-swap que implementa
 * app/api/admin/pedidos/[id]/refund/route.ts: el UPDATE a `ordenes` se
 * condiciona al `financial_status` que se leyó momentos antes de decidir
 * si el pedido era reintegrable. Con Postgres real, el row-level locking
 * de la transacción garantiza que como mucho una escritura concurrente
 * puede cumplir esa condición sobre la misma fila; acá se modela ese
 * invariante de forma sincrónica, sin necesitar una base de datos real.
 */
function conditionalRefundUpdate(
  row: { id: number; financial_status: string | null },
  expectedFinancialStatus: string | null,
  nextFinancialStatus: string,
) {
  if (row.financial_status !== expectedFinancialStatus) return null

  row.financial_status = nextFinancialStatus
  return { ...row }
}

test("dos reintegros concurrentes sobre el mismo pedido: como mucho uno gana el claim", () => {
  const row = { id: 1, financial_status: "refund_pending" }
  // Ambas requests leyeron "refund_pending" antes de intentar escribir
  // (ambas pasaron isRefundableOrder con el mismo snapshot).
  const expectedRead = row.financial_status

  const resultA = conditionalRefundUpdate(row, expectedRead, "refunded")
  const resultB = conditionalRefundUpdate(row, expectedRead, "refunded")

  assert.ok(resultA !== null, "la primera request debe ganar el claim")
  assert.equal(
    resultB,
    null,
    "la segunda request debe perder el claim (0 filas afectadas) en vez de duplicar el reintegro",
  )
  assert.equal(row.financial_status, "refunded")
})

test("un pedido que otro proceso ya reintegró rechaza un intento con un snapshot desactualizado", () => {
  const row = { id: 1, financial_status: "refunded" }
  const staleExpectedRead = "refund_pending"

  const result = conditionalRefundUpdate(row, staleExpectedRead, "refunded")

  assert.equal(result, null)
  assert.equal(row.financial_status, "refunded")
})

test("un reintegro legítimo sin carrera gana su propio claim", () => {
  const row = { id: 1, financial_status: "refund_pending" }
  const result = conditionalRefundUpdate(row, "refund_pending", "refunded")

  assert.ok(result !== null)
  assert.equal(result?.financial_status, "refunded")
})

test("el caso financial_status=null también queda cubierto por el claim (comparación explícita, no `=== null` implícito de SQL)", () => {
  const row = { id: 1, financial_status: null }
  const resultA = conditionalRefundUpdate(row, null, "refunded")
  const resultB = conditionalRefundUpdate(row, null, "refunded")

  assert.ok(resultA !== null)
  assert.equal(resultB, null)
})
