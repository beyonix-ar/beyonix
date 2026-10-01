import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  clearInterestFreeInstallmentsCache,
  getInterestFreeInstallments,
  INTEREST_FREE_CACHE_TTL_MS,
  INTEREST_FREE_ERROR_CACHE_TTL_MS,
  parseInterestFreeInstallmentCounts,
} from "./interest-free-installments.ts"

// Respuestas con la MISMA forma que devuelve GET /v1/payment_methods/installments
// (verificada contra la cuenta real, sólo lectura).
const FREE = ["interest_deduction_by_collector", "CFT_0,00%|TEA_0,00%"]
const cost = (installments: number, free: boolean) => ({
  installments,
  installment_rate: free ? 0 : 20,
  labels: free ? FREE : ["CFT_199,00%|TEA_150,00%"],
})
const issuer = (...costs: ReturnType<typeof cost>[]) => ({ issuer: { name: "Banco" }, payer_costs: [cost(1, false), ...costs] })

// $200: ninguna cuota sin interés. $40.000: 2 y 3. $70.000: 2, 3 y 6.
const LOW_AMOUNT = [issuer(cost(2, false), cost(3, false), cost(6, false))]
const MID_AMOUNT = [issuer(cost(2, true), cost(3, true), cost(6, false), cost(12, false))]
const HIGH_AMOUNT = [issuer(cost(2, true), cost(3, true), cost(6, true), cost(12, false))]

test("sólo 'sin interés' con interest_deduction_by_collector: monto bajo sin promo -> ninguna", () => {
  assert.deepEqual(parseInterestFreeInstallmentCounts([LOW_AMOUNT, LOW_AMOUNT]), [])
})

test("monto que habilita 2 y 3 -> sólo esas; monto que habilita 2/3/6 -> todas", () => {
  assert.deepEqual(parseInterestFreeInstallmentCounts([MID_AMOUNT, MID_AMOUNT]), [2, 3])
  assert.deepEqual(parseInterestFreeInstallmentCounts([HIGH_AMOUNT, HIGH_AMOUNT]), [2, 3, 6])
})

test("conservador: si un banco cobra interés en esa cuota, o una cuota menor ofrecida no es sin interés, no se confirma", () => {
  const oneBankCharges = [issuer(cost(2, true), cost(3, true), cost(6, true)), issuer(cost(2, true), cost(3, true), cost(6, false))]
  assert.deepEqual(parseInterestFreeInstallmentCounts([oneBankCharges]), [2, 3])
  // Tasa 0 sin la etiqueta del vendedor: no es "sin interés" confirmado.
  assert.deepEqual(parseInterestFreeInstallmentCounts([[{ payer_costs: [{ installments: 3, installment_rate: 0, labels: [] }] }]]), [])
  // 6 sin interés pero 4 (ofrecida) con interés: con máximo 6 el comprador podría elegir 4.
  const gap = [issuer(cost(2, true), cost(3, true), cost(4, false), cost(6, true))]
  assert.deepEqual(parseInterestFreeInstallmentCounts([gap]), [2, 3])
  // Respuesta con otro formato: nada confirmado.
  assert.equal(parseInterestFreeInstallmentCounts([{ message: "invalid" }]), null)
})

function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }
  return { fetch, calls }
}

test("consulta a Mercado Pago del lado servidor (Visa y Mastercard) y cachea 10 minutos por monto", async () => {
  clearInterestFreeInstallmentsCache()
  let now = 1_000_000
  const { fetch, calls } = fakeFetch(HIGH_AMOUNT)
  const dependencies = { fetch, accessToken: "TEST-token", now: () => now }

  assert.deepEqual(await getInterestFreeInstallments(70_000, dependencies), { status: "confirmed", counts: [2, 3, 6] })
  assert.equal(calls.length, 2)
  assert.match(calls[0], /\/v1\/payment_methods\/installments\?amount=70000&payment_method_id=visa$/)
  assert.match(calls[1], /payment_method_id=master$/)

  await getInterestFreeInstallments(70_000, dependencies)
  assert.equal(calls.length, 2, "segunda consulta desde caché")
  now += INTEREST_FREE_CACHE_TTL_MS + 1
  await getInterestFreeInstallments(70_000, dependencies)
  assert.equal(calls.length, 4, "vencida la caché, se vuelve a consultar")
})

test("fallo de Mercado Pago -> 'unavailable' (nunca 'sin interés'); el error se cachea poco tiempo", async () => {
  clearInterestFreeInstallmentsCache()
  let now = 5_000_000
  const failing = fakeFetch({ message: "error" }, 500)
  const dependencies = { fetch: failing.fetch, accessToken: "TEST-token", now: () => now }
  assert.deepEqual(await getInterestFreeInstallments(40_000, dependencies), { status: "unavailable" })
  const callsAfterError = failing.calls.length
  await getInterestFreeInstallments(40_000, dependencies)
  assert.equal(failing.calls.length, callsAfterError, "no martilla a Mercado Pago")
  now += INTEREST_FREE_ERROR_CACHE_TTL_MS + 1
  await getInterestFreeInstallments(40_000, dependencies)
  assert.ok(failing.calls.length > callsAfterError, "reintenta pronto")

  clearInterestFreeInstallmentsCache()
  const timeout = async () => { throw new DOMException("timeout", "TimeoutError") }
  assert.deepEqual(await getInterestFreeInstallments(40_000, { fetch: timeout, accessToken: "TEST-token" }), { status: "unavailable" })
  clearInterestFreeInstallmentsCache()
  assert.deepEqual(await getInterestFreeInstallments(40_000, { fetch: fakeFetch(MID_AMOUNT).fetch, accessToken: "" }), { status: "unavailable" }, "sin token no consulta")
  assert.deepEqual(await getInterestFreeInstallments(-5, { fetch: fakeFetch(MID_AMOUNT).fetch, accessToken: "TEST-token" }), { status: "unavailable" })
})

test("consultas simultáneas del mismo monto comparten un solo pedido", async () => {
  clearInterestFreeInstallmentsCache()
  const { fetch, calls } = fakeFetch(MID_AMOUNT)
  const dependencies = { fetch, accessToken: "TEST-token" }
  const [first, second] = await Promise.all([
    getInterestFreeInstallments(40_000, dependencies),
    getInterestFreeInstallments(40_000, dependencies),
  ])
  assert.deepEqual(first, second)
  assert.equal(calls.length, 2, "una consulta por medio de referencia, no por pedido")
})

// El checkout, el tier y los casos A-J viven en lib/pricing/financing-tier.test.ts.

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : listSources(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

test("sin umbrales hardcodeados: nada de cuotas/precios fija $35.000 / $60.000", () => {
  const installmentsSources = [
    ...listSources("lib/pricing"),
    ...listSources("lib/products"),
    ...listSources("components/products"),
    "lib/mercadopago/interest-free-installments.ts",
    "lib/mercadopago/interest-free-display.ts",
    "hooks/use-interest-free-installments.ts",
    "app/api/mercadopago/installments/route.ts",
    "app/checkout/page.tsx",
    "components/hero-section.tsx",
  ]
  const offenders = installmentsSources.filter((path) =>
    /\b(35[._]?000|60[._]?000)\b/.test(readFileSync(path, "utf8")),
  )
  assert.deepEqual(offenders, [])
})

