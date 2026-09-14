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

test("nunca busca indefinidamente: se frena en el tope defensivo de páginas (40 x 50 = 2000) si Mercado Pago siempre devuelve páginas llenas, y marca exhaustive=false", async () => {
  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    // Siempre devuelve una página LLENA (50), simulando una cuenta con
    // decenas de miles de movimientos -- si no hubiera tope, esto nunca
    // terminaría.
    const results = Array.from({ length: 50 }, (_, i) => fullPagePayment(offset + i + 1))
    return jsonResponse({ results, paging: { total: 100_000, offset, limit: 50 } })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 40, "debe frenar en el tope de páginas, nunca seguir indefinidamente")
  assert.equal(result.candidates.length, 2000)
  assert.equal(
    result.exhaustive,
    false,
    "se cortó por el tope sin poder demostrar que se cubrió toda la ventana -- nunca se puede auto-confirmar con esto",
  )
})

test("un candidato válido en una página MÁS ALLÁ del viejo tope de 4 páginas (200 movimientos) igual se encuentra, y exhaustive queda en true", async () => {
  let calls = 0
  const TARGET_PAGE = 7 // página 8 (offset 350): antes del fix esto NUNCA se recorría.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    const page = offset / 50

    if (page < TARGET_PAGE) {
      // Páginas previas: llenas, pero de movimientos irrelevantes (otro monto).
      const results = Array.from({ length: 50 }, (_, i) => ({
        ...fullPagePayment(offset + i + 1),
        transaction_amount: 111,
      }))
      return jsonResponse({ results, paging: { total: 450, offset, limit: 50 } })
    }

    // Última página (parcial): acá está el candidato real, con el monto buscado.
    return jsonResponse({
      results: [fullPagePayment(offset + 1)],
      paging: { total: 450, offset, limit: 50 },
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, TARGET_PAGE + 1)
  assert.equal(result.exhaustive, true)
  const relevant = result.candidates.filter((c) => c.transactionAmount === 900)
  assert.equal(relevant.length, 1, "el candidato de la página 8 debe encontrarse, no sólo los de las primeras 4 páginas")
})

test("una página parcial (menos de 50 resultados) corta la paginación antes de llegar al tope, y exhaustive queda en true", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return jsonResponse({
      results: [fullPagePayment(1), fullPagePayment(2)],
      paging: { total: 2, offset: 0, limit: 50 },
    })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 1)
  assert.equal(result.candidates.length, 2)
  assert.equal(result.exhaustive, true)
})

test("paging.total confirma cobertura completa incluso si la última página vino llena (evita una página final vacía)", async () => {
  let calls = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get("offset"))
    const results = Array.from({ length: 50 }, (_, i) => fullPagePayment(offset + i + 1))
    // paging.total=50: la única página que existe vino exactamente llena.
    return jsonResponse({ results, paging: { total: 50, offset, limit: 50 } })
  }) as typeof fetch

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(calls, 1, "paging.total ya confirma que no hay más: no debe pedir una segunda página vacía")
  assert.equal(result.exhaustive, true)
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

  const result = await searchIncomingBankTransfers({
    beginDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-14T00:00:00.000Z"),
  })

  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].id, "3")
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
