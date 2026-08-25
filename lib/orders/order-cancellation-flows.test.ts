import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { isOrderPaymentConfirmed } from "./order-payment-status.ts"

test("isOrderPaymentConfirmed usa exclusivamente evidencia financiera", () => {
  assert.equal(isOrderPaymentConfirmed({ paid_at: "2026-08-16T12:00:00.000Z" }), true)
  assert.equal(isOrderPaymentConfirmed({ payment_confirmed_amount: 10_000 }), true)

  for (const paymentStatus of ["confirmado", "approved", "confirmed"]) {
    assert.equal(isOrderPaymentConfirmed({ payment_status: paymentStatus }), true)
  }

  for (const financialStatus of [
    "payment_confirmed",
    "refund_pending",
    "refunded",
  ]) {
    assert.equal(isOrderPaymentConfirmed({ financial_status: financialStatus }), true)
  }

  for (const order of [
    {},
    { estado: "pagado" },
    { estado: "enviado" },
    { estado: "entregado" },
    { payment_status: "pending" },
    { financial_status: "cancellation_requested" },
    { payment_status: "en_revision", estado: "cancelado" },
  ]) {
    assert.equal(isOrderPaymentConfirmed(order), false)
  }
})

test("la aprobación por reclamo delega la transición financiera atómica", () => {
  const routeSource = readFileSync(
    new URL(
      "../../app/api/admin/order-claims/[claimId]/route.ts",
      import.meta.url,
    ),
    "utf8",
  )
  const approveBlock = routeSource.slice(
    routeSource.indexOf('if (body.action === "approve_cancellation")'),
    routeSource.indexOf('if (body.action === "reject_cancellation")'),
  )

  assert.match(approveBlock, /\.rpc\(\s*"approve_order_claim_cancellation"/)
  assert.doesNotMatch(approveBlock, /\.from\("ordenes"\)\s*\.update\(/)
  assert.doesNotMatch(routeSource, /upsertCustomerCancelledOrderNotification/)
  assert.equal(
    approveBlock.match(/notifyCancellationResolution\(/g)?.length,
    1,
  )
})

test("la RPC serializa la cancelación y mantiene juntos sus efectos críticos", () => {
  const migrationSource = readFileSync(
    new URL(
      "../../supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(
    migrationSource,
    /from public\.order_claims[\s\S]*?for update;[\s\S]*?from public\.ordenes[\s\S]*?for update;/,
  )
  assert.match(
    migrationSource,
    /when v_payment_confirmed then 'refund_pending'[\s\S]*?else 'cancelled'/,
  )
  assert.match(
    migrationSource,
    /refund_pending_at = case when v_payment_confirmed then v_now else null end/,
  )
  assert.match(migrationSource, /reverse_customer_credit_for_order\(/)
  assert.match(migrationSource, /insert into public\.order_audit_events/)
  assert.match(migrationSource, /v_previous_financial_status/)
  assert.match(migrationSource, /insert into public\.order_claim_messages/)
  assert.doesNotMatch(migrationSource, /update public\.(productos|producto_variantes)/)
})

test("la cancelación directa del cliente también delega orden y claim a una RPC atómica", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/orders/[id]/cancel/route.ts", import.meta.url),
    "utf8",
  )
  const migrationSource = readFileSync(
    new URL(
      "../../supabase/migrations/20260825130000_atomic_customer_cancellation_claim.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(routeSource, /\.rpc\(\s*"request_customer_order_cancellation_with_claim"/)
  assert.doesNotMatch(routeSource, /\.from\("ordenes"\)\s*\.update\(/)
  assert.match(migrationSource, /from public\.ordenes[\s\S]*for update/)
  assert.match(migrationSource, /insert into public\.order_claims/)
  assert.match(migrationSource, /update public\.ordenes/)
})

test("las firmas de archivos de reclamos se piden en un solo lote (sin N+1) y conservan la asociación por id de reclamo", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/admin/pedidos/route.ts", import.meta.url),
    "utf8",
  )

  // Una sola llamada a createSignedUrls por carga de listado, no una por
  // archivo (createSignedUrl singular sería el N+1 que se corrigió).
  assert.match(routeSource, /\.createSignedUrls\(/)
  assert.doesNotMatch(routeSource, /\.createSignedUrl\(/)
  assert.match(routeSource, /signedFilesByClaimId\.set\(entry\.claimId, current\)/)
  assert.match(
    routeSource,
    /order_claim_files: signedFilesByClaimId\.get\(claim\.id\) \?\? \[\]/,
  )
})
