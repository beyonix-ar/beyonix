import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { arcaAutoInvoicingView, isOrderInAutoInvoicingQueue } from "./auto-invoicing-control.ts"
import type { ArcaConfigurationStatus } from "./configuration.ts"

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

const production: ArcaConfigurationStatus = {
  configured: true,
  environment: "production",
  certificateType: "production",
  certificateExpiresAt: "2028-10-02T14:44:08Z",
  cuitMatches: true,
  privateKeyMatches: true,
  pointOfSale: 1,
  pointOfSaleConfigured: true,
  autoInvoicingEnabled: true,
  errors: [],
}

test("la activación exige simultáneamente flag servidor, PROD y control persistente", () => {
  const control = { enabled: true, cutoff_at: "2026-10-03T15:00:00Z", updated_at: "2026-10-03T15:00:00Z" }
  assert.equal(arcaAutoInvoicingView(control, production).enabled, true)
  assert.equal(arcaAutoInvoicingView(control, { ...production, autoInvoicingEnabled: false }).controlEnabled, true)
  assert.equal(arcaAutoInvoicingView({ ...control, enabled: false }, production).enabled, false)
  assert.equal(arcaAutoInvoicingView({ ...control, cutoff_at: null }, production).enabled, false)
  assert.equal(arcaAutoInvoicingView(control, { ...production, autoInvoicingEnabled: false }).enabled, false)
  assert.equal(arcaAutoInvoicingView(control, { ...production, environment: "homologation" }).enabled, false)
})

test("cron y control Admin fallan cerrados, con secreto y roles correctos", () => {
  const cron = read("app/api/cron/arca-invoices/route.ts")
  const control = read("app/api/admin/arca/auto-invoicing/route.ts")
  const migration = read("supabase/migrations/20261003120000_arca_auto_invoicing_activation.sql")
  assert.match(cron, /isCronRequestAuthorized\(request\.headers\.get\("authorization"\), process\.env\.CRON_SECRET\)/)
  assert.ok(cron.indexOf("ARCA_AUTO_INVOICING_ENABLED") < cron.indexOf("processArcaInvoiceQueue(admin"))
  assert.ok(cron.indexOf("arcaAutoInvoicingView") < cron.indexOf("processArcaInvoiceQueue(admin"))
  assert.match(control, /requireAdmin\(request\)/)
  assert.match(control, /set_arca_auto_invoicing/)
  assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/)
  assert.match(migration, /grant select on public\.arca_auto_invoicing_control to service_role/)
  assert.doesNotMatch(migration, /grant[^;]*update on public\.arca_auto_invoicing_control/i)
  assert.match(migration, /ARCA_FIRST_MANUAL_INVOICE_REQUIRED/)
  assert.match(migration, /invoice_queued_at > v_cutoff/)
  assert.match(migration, /invoice_arca_environment = 'production'/)
  assert.doesNotMatch(migration, /delete from public\.ordenes|update public\.ordenes set invoice_status = 'pending'/i)
})

test("systemd ARCA usa loopback, secreto privado, flock y timeout; Vercel no lo programa", () => {
  const service = read("deploy/systemd/beyonix-arca-invoices.service")
  const timer = read("deploy/systemd/beyonix-arca-invoices.timer")
  const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string }> }
  assert.match(service, /\/usr\/bin\/flock -n \/run\/lock\/beyonix-arca-invoices\.lock/)
  assert.match(service, /--config \/etc\/beyonix\/curl-verify-transfer-orders\.conf/)
  assert.match(service, /--max-time 180/)
  assert.match(service, /User=root/)
  assert.match(service, /WorkingDirectory=\//)
  assert.match(service, /TimeoutStartSec=190/)
  assert.match(service, /http:\/\/127\.0\.0\.1:3000\/api\/cron\/arca-invoices/)
  assert.doesNotMatch(service, /\$\{CRON_SECRET\}|-H\s+["']?Authorization/)
  assert.match(timer, /OnCalendar=\*-\*-\* \*:0\/5:00/)
  assert.match(timer, /Persistent=true/)
  assert.ok(vercel.crons.every((cron) => cron.path !== "/api/cron/arca-invoices"))
})

test("cola automática: misma regla que el claim automático de claim_arca_invoice", () => {
  const control = { enabled: true, cutoff_at: "2026-10-03T15:00:00Z", updated_at: "2026-10-03T15:00:00Z" }
  const on = arcaAutoInvoicingView(control, production)
  const queued = {
    invoice_status: "pending", invoice_cae: null, invoice_number: null, invoice_arca_environment: null,
    invoice_next_attempt_at: "2026-10-05T12:00:00Z", invoice_queued_at: "2026-10-05T11:00:00Z",
  }
  assert.equal(isOrderInAutoInvoicingQueue(on, queued), true)
  assert.equal(isOrderInAutoInvoicingQueue(on, { ...queued, invoice_status: "error" }), true, "reintento con backoff")
  // Automático desactivado (control, flag del servidor o fuera de PROD): nadie la emite.
  for (const off of [
    arcaAutoInvoicingView({ ...control, enabled: false }, production),
    arcaAutoInvoicingView(control, { ...production, autoInvoicingEnabled: false }),
    arcaAutoInvoicingView(control, { ...production, environment: "homologation" }),
  ]) assert.equal(isOrderInAutoInvoicingQueue(off, queued), false)
  // Fuera de la cola del worker aunque el automático esté activo.
  assert.equal(isOrderInAutoInvoicingQueue(on, { ...queued, invoice_queued_at: "2026-10-01T10:00:00Z" }), false, "anterior al corte")
  assert.equal(isOrderInAutoInvoicingQueue(on, { ...queued, invoice_queued_at: null }), false)
  assert.equal(isOrderInAutoInvoicingQueue(on, { ...queued, invoice_status: "error", invoice_next_attempt_at: null }), false, "error sin reintento")
  assert.equal(isOrderInAutoInvoicingQueue(on, { ...queued, invoice_number: 12 }), false, "número pedido: conciliación manual")
  assert.equal(isOrderInAutoInvoicingQueue(on, { ...queued, invoice_arca_environment: "homologation" }), false)
  assert.equal(isOrderInAutoInvoicingQueue(on, { ...queued, invoice_status: null }), false, "fuera de la cola")
  // La regla espeja el filtro real de la migración.
  const migration = read("supabase/migrations/20261003120000_arca_auto_invoicing_activation.sql")
  assert.match(migration, /o\.invoice_status in \('pending', 'error'\) and o\.invoice_next_attempt_at <= v_now/)
  assert.match(migration, /and o\.invoice_queued_at > v_cutoff\s+and o\.invoice_cae is null\s+and o\.invoice_number is null/)
})
