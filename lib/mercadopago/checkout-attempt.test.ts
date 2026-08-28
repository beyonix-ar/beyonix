import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  createMercadoPagoCheckoutFingerprint,
  getMercadoPagoCheckoutAttemptDecision,
  getMercadoPagoCheckoutIdempotencyKey,
  normalizeMercadoPagoCheckoutSessionId,
  type MercadoPagoCheckoutFingerprintInput,
} from "./checkout-attempt.ts"
import { processApprovedMercadoPagoOrderPayment } from "./order-payment.ts"

const checkout: MercadoPagoCheckoutFingerprintInput = {
  sessionId: "4cb6ca5a-f946-4a56-9f3f-5e65c48e41c8",
  userId: null,
  items: [
    {
      productId: 10,
      quantity: 2,
      variantId: 4,
      conditionedStockId: null,
    },
  ],
  customer: {
    cliente_nombre: "María Muñoz",
    cliente_email: "maria@example.com",
    cliente_telefono: "+54 11 5555-1234",
    cliente_dni: "30123456",
    cliente_direccion: "Avenida Córdoba 1234",
    cp_destino: "3230",
    localidad: "Paso de los Libres",
    provincia: "Corrientes",
  },
  productsTotal: 20_000,
  shipping: {
    provider: "andreani",
    type: "domicilio",
    costReal: 5_000,
    costCharged: 5_000,
    freeShippingApplied: false,
  },
  storeBenefitId: null,
  requestedCredit: 0,
  installmentsModality: null,
}

test("el mismo checkout genera una única identidad reutilizable", () => {
  const firstFingerprint = createMercadoPagoCheckoutFingerprint(checkout)
  const repeatedFingerprint = createMercadoPagoCheckoutFingerprint({
    ...checkout,
    items: [...checkout.items].reverse(),
  })

  assert.equal(firstFingerprint, repeatedFingerprint)
  assert.equal(
    getMercadoPagoCheckoutIdempotencyKey(firstFingerprint),
    getMercadoPagoCheckoutIdempotencyKey(repeatedFingerprint),
  )

  const decision = getMercadoPagoCheckoutAttemptDecision(
    {
      id: 25,
      estado: "pendiente",
      financial_status: "pending_payment",
      payment_status: "preference_created",
      payment_method_id: "mercadopago",
      mercadopago_init_point: "https://mercadopago.example/checkout/25",
      mercadopago_preference_expires_at: "2026-08-15T15:00:00.000Z",
    },
    new Date("2026-08-15T14:00:00.000Z"),
  )

  assert.deepEqual(decision, {
    kind: "reuse",
    initPoint: "https://mercadopago.example/checkout/25",
  })
})

test("una orden pagada nunca vuelve a tratarse como pendiente", () => {
  const decision = getMercadoPagoCheckoutAttemptDecision({
    id: 25,
    estado: "pagado",
    financial_status: "payment_confirmed",
    payment_status: "approved",
    payment_method_id: "mercadopago",
    mercadopago_init_point: "https://mercadopago.example/checkout/25",
    mercadopago_preference_expires_at: "2099-01-01T00:00:00.000Z",
  })

  assert.deepEqual(decision, { kind: "already_paid" })
})

test("un pago pendiente no habilita otra preferencia al vencer el checkout", () => {
  const decision = getMercadoPagoCheckoutAttemptDecision(
    {
      id: 25,
      estado: "pendiente",
      financial_status: "pending_payment",
      payment_status: "pending",
      payment_method_id: "mercadopago",
      mercadopago_preference_expires_at: "2026-08-15T13:00:00.000Z",
    },
    new Date("2026-08-15T14:00:00.000Z"),
  )

  assert.deepEqual(decision, { kind: "in_progress" })
})

test("compras diferentes no comparten huella ni clave idempotente", () => {
  const firstFingerprint = createMercadoPagoCheckoutFingerprint(checkout)
  const differentFingerprint = createMercadoPagoCheckoutFingerprint({
    ...checkout,
    items: [{ ...checkout.items[0], quantity: 3 }],
  })

  assert.notEqual(firstFingerprint, differentFingerprint)
  assert.notEqual(
    getMercadoPagoCheckoutIdempotencyKey(firstFingerprint),
    getMercadoPagoCheckoutIdempotencyKey(differentFingerprint),
  )
})

test("cambiar la modalidad de cuotas para el mismo carrito genera una huella distinta", () => {
  // Si no fuera así, elegir "3 cuotas" después de haber iniciado un intento
  // en "pago único" (mismo carrito) reusaría/reclamaría la orden vieja, sin
  // aplicar nunca la financiación recién elegida.
  const singlePayment = createMercadoPagoCheckoutFingerprint(checkout)
  const threeInstallments = createMercadoPagoCheckoutFingerprint({
    ...checkout,
    installmentsModality: 3,
  })
  const sixInstallments = createMercadoPagoCheckoutFingerprint({
    ...checkout,
    installmentsModality: 6,
  })

  assert.notEqual(singlePayment, threeInstallments)
  assert.notEqual(singlePayment, sixInstallments)
  assert.notEqual(threeInstallments, sixInstallments)
})

test("la base bloquea dobles inserts y el claim de preferencia es atómico", () => {
  const inventoryMigration = readFileSync(
    new URL(
      "../../supabase/migrations/20260801104000_inventory_single_source_and_repair.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const checkoutMigration = readFileSync(
    new URL(
      "../../supabase/migrations/20260815120000_mercadopago_checkout_attempt_idempotency.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(
    inventoryMigration,
    /create unique index if not exists ordenes_checkout_idempotency_unique/i,
  )
  assert.match(
    checkoutMigration,
    /create or replace function public\.claim_mercadopago_order_preference/i,
  )
  assert.match(
    checkoutMigration,
    /mercadopago_preference_claimed_at < now\(\) - interval '5 minutes'/i,
  )
  assert.match(
    checkoutMigration,
    /returning mercadopago_preference_generation into v_generation/i,
  )
})

test("el webhook sigue confirmando la orden indicada por external_reference", async () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )
  let confirmedAmount: number | null = null
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "pendiente",
      financial_status: "pending_payment",
      total: 25_000,
      external_amount_due: 25_000,
    },
    {
      status: "approved",
      transaction_amount: 25_000,
      currency_id: "ARS",
    },
    async (amount) => {
      confirmedAmount = amount
      return true
    },
  )

  assert.match(webhook, /const orderId = Number\(payment\.external_reference\)/)
  assert.match(webhook, /\.eq\("id", orderId\)/)
  assert.deepEqual(result, { kind: "confirmed", confirmedAmount: 25_000 })
  assert.equal(confirmedAmount, 25_000)
})

test("un pago aprobado tardío puede recuperar una orden expirada", async () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )
  let confirmations = 0
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "cancelado",
      financial_status: "cancelled",
      total: 12_500,
      external_amount_due: 12_500,
    },
    {
      status: "approved",
      transaction_amount: 12_500,
      currency_id: "ARS",
    },
    async () => {
      confirmations += 1
      return true
    },
  )

  assert.equal(result.kind, "confirmed")
  assert.equal(confirmations, 1)
  assert.match(webhook, /estado: "pagado",\s+cancelled_at: null,/)
})

test("una sesión inválida no puede eludir la idempotencia", () => {
  assert.equal(normalizeMercadoPagoCheckoutSessionId(null), null)
  assert.equal(normalizeMercadoPagoCheckoutSessionId("corta"), null)
  assert.equal(
    normalizeMercadoPagoCheckoutSessionId(` ${checkout.sessionId} `),
    checkout.sessionId,
  )
})
