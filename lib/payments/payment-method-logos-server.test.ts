import assert from "node:assert/strict"
import test from "node:test"

import {
  loadPublicPaymentMethodLogos,
  PAYMENT_METHODS_SYNC_KEY,
  syncPaymentMethodLogos,
} from "./payment-method-logos-server.ts"
import type { PaymentMethodLogoRow } from "./payment-method-logos.ts"

// Cliente Supabase mínimo en memoria: sólo las operaciones que usa la
// sincronización (site_settings y payment_method_logos) y Storage público.
function fakeAdmin() {
  const settings = new Map<string, unknown>()
  const logos: PaymentMethodLogoRow[] = []
  let sequence = 0
  const writes: string[] = []

  const client = {
    settings,
    logos,
    writes,
    from(table: string) {
      if (table === "site_settings") {
        return {
          select: () => ({
            eq: (_column: string, key: string) => ({
              maybeSingle: async () => ({ data: settings.has(key) ? { value: settings.get(key) } : null, error: null }),
            }),
          }),
          upsert: async (row: { key: string; value: unknown }) => {
            writes.push(`settings:${row.key}`)
            settings.set(row.key, row.value)
            return { error: null }
          },
        }
      }
      assert.equal(table, "payment_method_logos")
      return {
        select: () => ({
          order: () => ({ order: async () => ({ data: logos.map((row) => ({ ...row })), error: null }) }),
        }),
        upsert: async (rows: Array<Partial<PaymentMethodLogoRow>>) => {
          writes.push(`insert:${rows.length}`)
          for (const insert of rows) {
            if (logos.some((row) => row.source === insert.source && row.provider_method_id === insert.provider_method_id)) continue
            sequence += 1
            logos.push({
              id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
              image_path: null,
              ...insert,
            } as PaymentMethodLogoRow)
          }
          return { error: null }
        },
        update: (changes: Partial<PaymentMethodLogoRow>) => ({
          eq: async (_column: string, id: string) => {
            writes.push("update")
            const row = logos.find((item) => item.id === id)
            if (row) Object.assign(row, changes)
            return { error: null }
          },
        }),
      }
    },
    storage: {
      from: () => ({ getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/payment-method-logos/${path}` } }) }),
    },
  }
  return client
}

type FakeAdmin = ReturnType<typeof fakeAdmin>
const asAdmin = (admin: FakeAdmin) => admin as unknown as Parameters<typeof syncPaymentMethodLogos>[0]

const MP_OK = [
  { id: "visa", name: "Visa", payment_type_id: "credit_card", status: "active" },
  { id: "master", name: "Mastercard", payment_type_id: "credit_card", status: "active" },
]
const okFetch = (body: unknown) => async () => Response.json(body)

test("sincroniza con Mercado Pago, registra la hora y el resultado es idempotente", async () => {
  const admin = fakeAdmin()
  const first = await syncPaymentMethodLogos(asAdmin(admin), { fetch: okFetch(MP_OK), accessToken: "token", now: new Date("2026-10-06T12:00:00Z") })
  assert.equal(first.ok, true)
  assert.equal(admin.logos.length, 2)
  assert.deepEqual(admin.settings.get(PAYMENT_METHODS_SYNC_KEY), {
    lastAttemptAt: "2026-10-06T12:00:00.000Z",
    lastSuccessAt: "2026-10-06T12:00:00.000Z",
    lastError: null,
  })
  const second = await syncPaymentMethodLogos(asAdmin(admin), { fetch: okFetch(MP_OK), accessToken: "token" })
  assert.equal(second.ok && second.summary.added, 0)
  assert.equal(admin.logos.length, 2, "sin duplicados")
})

test("fallo de la API de Mercado Pago: no se toca ninguna fila y se conserva el último éxito", async () => {
  const admin = fakeAdmin()
  await syncPaymentMethodLogos(asAdmin(admin), { fetch: okFetch(MP_OK), accessToken: "token", now: new Date("2026-10-06T12:00:00Z") })
  const visaRow = admin.logos.find((row) => row.provider_method_id === "visa")!
  visaRow.image_path = `${visaRow.id}/1759752000000.svg`
  const before = JSON.stringify(admin.logos)
  admin.writes.length = 0

  for (const failingFetch of [
    async () => new Response("error", { status: 500 }),
    async () => Response.json({ message: "invalid" }),
    async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" })
    },
  ]) {
    const result = await syncPaymentMethodLogos(asAdmin(admin), { fetch: failingFetch, accessToken: "token", now: new Date("2026-10-07T12:00:00Z") })
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(admin.logos), before, "último estado conocido intacto")
    const state = admin.settings.get(PAYMENT_METHODS_SYNC_KEY) as { lastSuccessAt: string; lastError: string; lastAttemptAt: string }
    assert.equal(state.lastSuccessAt, "2026-10-06T12:00:00.000Z")
    assert.equal(state.lastAttemptAt, "2026-10-07T12:00:00.000Z")
    assert.ok(state.lastError)
  }
  assert.ok(admin.writes.every((write) => write.startsWith("settings:")), `sólo se registró el fallo: ${admin.writes.join(",")}`)
  // Lo que ya se mostraba sigue mostrándose (no se vacía la tienda por un error).
  assert.deepEqual((await loadPublicPaymentMethodLogos(asAdmin(admin))).map((logo) => logo.name), ["Visa"])
})

test("sin credenciales: no se consulta Mercado Pago y se informa el motivo", async () => {
  const admin = fakeAdmin()
  let called = false
  const result = await syncPaymentMethodLogos(asAdmin(admin), {
    accessToken: "",
    fetch: async () => {
      called = true
      return Response.json([])
    },
  })
  assert.equal(called, false)
  assert.equal(result.ok, false)
  assert.match(result.ok ? "" : result.error, /no está configurado/)
  assert.equal(admin.logos.length, 0)
})

test("la tienda sólo recibe logos visibles: MP elimina el medio → oculto; lo reactiva → reaparece", async () => {
  const admin = fakeAdmin()
  await syncPaymentMethodLogos(asAdmin(admin), { fetch: okFetch(MP_OK), accessToken: "token" })
  for (const row of admin.logos) row.image_path = `${row.id}/1759752000000.png`
  assert.deepEqual((await loadPublicPaymentMethodLogos(asAdmin(admin))).map((logo) => logo.name), ["Mastercard", "Visa"])

  await syncPaymentMethodLogos(asAdmin(admin), { fetch: okFetch([MP_OK[1]]), accessToken: "token" })
  const visible = await loadPublicPaymentMethodLogos(asAdmin(admin))
  assert.deepEqual(visible.map((logo) => logo.name), ["Mastercard"])
  assert.ok(admin.logos.find((row) => row.provider_method_id === "visa")?.image_path, "la imagen se conserva")

  await syncPaymentMethodLogos(asAdmin(admin), { fetch: okFetch(MP_OK), accessToken: "token" })
  const restored = await loadPublicPaymentMethodLogos(asAdmin(admin))
  assert.deepEqual(restored.map((logo) => logo.name), ["Mastercard", "Visa"])
  const visaId = admin.logos.find((row) => row.provider_method_id === "visa")!.id
  assert.equal(restored[1].imageUrl, `https://storage.test/payment-method-logos/${visaId}/1759752000000.png`)
  assert.deepEqual(Object.keys(restored[0]).sort(), ["imageUrl", "key", "name", "paymentTypes", "providerMethodId", "source"], "sin estados internos")
})
