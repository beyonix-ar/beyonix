import assert from "node:assert/strict"
import test from "node:test"

import {
  isSupportedBankTransferKind,
  searchIncomingBankTransfers,
} from "./bank-transfer-search.ts"

const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN
const originalFetch = globalThis.fetch

test.before(() => {
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-secret-token-never-logged"
})
test.after(() => {
  if (originalToken === undefined) delete process.env.MERCADOPAGO_ACCESS_TOKEN
  else process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
  globalThis.fetch = originalFetch
})

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function fullPagePayment(id: number) {
  return {
    id,
    status: "approved",
    operation_type: "money_transfer",
    payment_method_id: "account_money",
    transaction_amount: 900,
    currency_id: "ARS",
    date_created: "2026-09-13T18:17:43.000-04:00",
    date_approved: "2026-09-13T18:17:43.000-04:00",
    payer: { identification: { type: "CUIL", number: "20301112220" } },
    transaction_details: { bank_transfer_id: null },
  }
}

test("isSupportedBankTransferKind sólo admite los dos tipos comprobados contra la cuenta real", () => {
  assert.equal(isSupportedBankTransferKind("account_fund", "cvu"), true)
  assert.equal(isSupportedBankTransferKind("money_transfer", "account_money"), true)
  assert.equal(isSupportedBankTransferKind("regular_payment", "account_money"), false)
  assert.equal(isSupportedBankTransferKind("money_transfer", "visa"), false)
  assert.equal(isSupportedBankTransferKind(null, null), false)
})

test("nunca busca más de 200 movimientos (4 páginas x 50) aunque Mercado Pago siga devolviendo páginas llenas", async () => {
  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    // Siempre devuelve una página LLENA (50), simulando una cuenta con miles
    // de movimientos -- si no hubiera tope, esto nunca terminaría.
    const results = Array.from({ length: 50 }, (_, i) => fullPagePayment(offset + i + 1))
    return jsonResponse({ results, paging: { total: 10_000, offset, limit: 50 } })
  }) as typeof fetch

  const candidates = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 4, "debe frenar en el tope de 4 páginas, nunca seguir indefinidamente")
  assert.equal(candidates.length, 200)
})

test("una página parcial (menos de 50 resultados) corta la paginación antes de llegar al tope", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse({
      results: [fullPagePayment(1), fullPagePayment(2)],
      paging: { total: 2, offset: 0, limit: 50 },
    })
  }) as typeof fetch

  const candidates = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 1)
  assert.equal(candidates.length, 2)
})

test("filtra en backend: nunca incluye movimientos no aprobados ni tipos no soportados", async () => {
  globalThis.fetch = (async () =>
    jsonResponse({
      results: [
        { ...fullPagePayment(1), status: "pending" },
        { ...fullPagePayment(2), operation_type: "regular_payment", payment_method_id: "visa" },
        fullPagePayment(3),
      ],
      paging: { total: 3, offset: 0, limit: 50 },
    })) as typeof fetch

  const candidates = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].id, "3")
})

test("rechaza una ventana de búsqueda invertida o demasiado amplia (nunca busca indefinidamente todo el historial)", async () => {
  await assert.rejects(
    searchIncomingBankTransfers({
      beginDate: new Date("2026-09-14T00:00:00.000Z"),
      endDate: new Date("2026-09-01T00:00:00.000Z"),
    }),
    /Ventana de búsqueda inválida/,
  )

  await assert.rejects(
    searchIncomingBankTransfers({
      beginDate: new Date("2020-01-01T00:00:00.000Z"),
      endDate: new Date("2026-09-14T00:00:00.000Z"),
    }),
    /Ventana de búsqueda demasiado amplia/,
  )
})

test("nunca envía el access token en la URL, sólo en el header Authorization", async () => {
  let capturedUrl = ""
  let capturedAuth: string | null = null
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input)
    capturedAuth = new Headers(init?.headers).get("authorization")
    return jsonResponse({ results: [], paging: { total: 0, offset: 0, limit: 50 } })
  }) as typeof fetch

  await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.doesNotMatch(capturedUrl, /TEST-secret-token/)
  assert.equal(capturedAuth, "Bearer TEST-secret-token-never-logged")
})
