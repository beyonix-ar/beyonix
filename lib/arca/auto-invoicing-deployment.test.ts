import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { arcaAutoInvoicingView } from "./auto-invoicing-control.ts"
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
