import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { processApprovedMercadoPagoOrderPayment } from "./order-payment.ts"

test("un pago aprobado con monto incorrecto no confirma la orden", async () => {
  let confirmations = 0
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "pendiente",
      financial_status: "pending_payment",
      total: 25_000,
      external_amount_due: 20_000.5,
    },
    {
      status: "approved",
      currency_id: "ARS",
      transaction_amount: 20_000.49,
    },
    async () => {
      confirmations += 1
      return true
    },
  )

  assert.equal(result.kind, "amount_mismatch")
  assert.equal(confirmations, 0)
})

test("un pago aprobado confirma el importe real correcto en centavos", async () => {
  let persistedAmount: number | null = null
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "pendiente",
      financial_status: "pending_payment",
      total: 25_000,
      external_amount_due: 20_000.5,
    },
    {
      status: "approved",
      currency_id: "ARS",
      transaction_amount: 20_000.5,
    },
    async (confirmedAmount) => {
      persistedAmount = confirmedAmount
      return true
    },
  )

  assert.deepEqual(result, {
    kind: "confirmed",
    confirmedAmount: 20_000.5,
  })
  assert.equal(persistedAmount, 20_000.5)
})

test("repetir un webhook confirmado no repite la confirmación", async () => {
  const order = {
    estado: "pendiente",
    financial_status: "pending_payment",
    total: 10_000,
    external_amount_due: 10_000,
  }
  const payment = {
    status: "approved",
    currency_id: "ARS",
    transaction_amount: 10_000,
  }
  let confirmations = 0
  const confirm = async () => {
    confirmations += 1
    order.estado = "pagado"
    order.financial_status = "payment_confirmed"
    return true
  }

  const first = await processApprovedMercadoPagoOrderPayment(
    order,
    payment,
    confirm,
  )
  const repeated = await processApprovedMercadoPagoOrderPayment(
    order,
    payment,
    confirm,
  )

  assert.equal(first.kind, "confirmed")
  assert.equal(repeated.kind, "duplicate")
  assert.equal(confirmations, 1)
})

test("una carrera perdida se trata como webhook duplicado", async () => {
  let sideEffects = 0
  const result = await processApprovedMercadoPagoOrderPayment(
    {
      estado: "pendiente",
      financial_status: "pending_payment",
      total: 10_000,
      external_amount_due: 10_000,
    },
    {
      status: "approved",
      currency_id: "ARS",
      transaction_amount: 10_000,
    },
    async () => false,
  )

  if (result.kind === "confirmed") sideEffects += 1

  assert.equal(result.kind, "duplicate")
  assert.equal(sideEffects, 0)
})

test("el webhook duplicado no crea stock ni factura como efecto lateral", () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )

  assert.doesNotMatch(
    webhook,
    /(?:reserve|decrement|update).*stock|create.*(?:invoice|factura)/i,
  )
  assert.match(
    webhook,
    /if \(paymentResult\.kind === "duplicate"\)[\s\S]*duplicated: true/,
  )
})

test("la persistencia de approved_stock_conflict revisa el error y nunca falla en silencio", () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )

  // BUG CONFIRMADO CONTRA LA BASE REAL: ordenes_admin_visibility_payment_check
  // (20260815140000) rechazaba payment_status='approved_stock_conflict'
  // porque nunca se actualizó junto con set_order_admin_visibility()
  // (20260903160000) -- y esta escritura no revisaba el error, así que la
  // falla era invisible. Corregido en ambos lados: constraint (ver
  // supabase/migrations/20260906130000_...) y este chequeo de error.
  assert.match(
    webhook,
    /stockConflictUpdateError[\s\S]{0,50}=\s*await supabase[\s\S]{0,400}payment_status: MERCADOPAGO_STOCK_CONFLICT_PAYMENT_STATUS/,
  )
  assert.match(
    webhook,
    /if \(stockConflictUpdateError\)\s*\{[\s\S]{0,300}throw stockConflictUpdateError/,
  )
})

test("el constraint de admin_visible_at acepta los tres estados de conflicto post-aprobación", () => {
  const migration = readFileSync(
    "supabase/migrations/20260906130000_fix_admin_visibility_check_for_payment_conflicts.sql",
    "utf8",
  )

  assert.match(migration, /drop constraint if exists ordenes_admin_visibility_payment_check/)
  assert.match(
    migration,
    /payment_status in \(\s*\n\s*'approved_amount_mismatch',\s*\n\s*'approved_currency_mismatch',\s*\n\s*'approved_stock_conflict'\s*\n\s*\)\s*\n\s*and payment_id is not null/,
  )
})

test("un reintegro/contracargo notificado DESPUÉS de confirmado no se descarta en silencio", () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )

  // El branch de reverso post-confirmación vive DENTRO del "ya confirmado",
  // así que nunca puede faltar el chequeo de pertenencia contra el
  // payment_id ya persistido -- sin él, un contracargo de un pago distinto
  // que comparta external_reference podría marcar el pedido equivocado.
  assert.match(
    webhook,
    /POST_CONFIRMATION_REVERSAL_STATUSES\.has\(payment\.status\)\s*&&\s*\n\s*orderRow\.payment_id === String\(payment\.id\)/,
  )
  // Idempotente: un mismo reverso notificado dos veces no debe volver a
  // auditar ni a "actualizar" nada la segunda vez.
  assert.match(webhook, /\.neq\("payment_status", payment\.status\)/)
  // Nunca toca stock/saldo/envío automáticamente -- requiere resolución
  // manual, igual que approved_stock_conflict.
  assert.doesNotMatch(
    webhook,
    /POST_CONFIRMATION_REVERSAL_STATUSES[\s\S]{0,600}reverseCustomerCreditForOrder/,
  )
})

test("refunded y charged_back quedan modelados como reversos post-confirmación, no como estados de pre-aprobación", () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )

  assert.match(
    webhook,
    /POST_CONFIRMATION_REVERSAL_STATUSES = new Set\(\["refunded", "charged_back"\]\)/,
  )
})

test("CASO I (precio único): el webhook valida el pago contra external_amount_due/total (el precio público del pedido), nunca recalcula por cuotas/porcentajes", () => {
  const webhook = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )

  // Bajo el modelo de precio público único, total/external_amount_due YA SON
  // el precio público (create-preference no le suma recargo por cuotas, ver
  // lib/orders/checkout-order-creation.test.ts) -- el webhook simplemente
  // compara el pago real contra esos campos, sin importarle nunca
  // cuotas/porcentajes/config financiera.
  assert.doesNotMatch(webhook, /products\/installments/)
  assert.doesNotMatch(webhook, /installments_percent/)
  assert.match(webhook, /processApprovedMercadoPagoOrderPayment/)

  // Persiste el costo REAL informado por Mercado Pago (distinto del %
  // configurado) para poder mostrar a futuro costos/neto reales en Admin.
  assert.match(webhook, /mercadopago_payment_snapshot/)
  assert.match(webhook, /fee_details/)
  assert.match(webhook, /transaction_details/)
})
