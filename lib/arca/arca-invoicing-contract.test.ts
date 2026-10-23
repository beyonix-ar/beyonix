import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { ArcaConfigurationError, getConfiguredArcaEnvironment } from "./environment.ts"
import { getInvoiceFiscalStatusView } from "./invoice-status-view.ts"

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

test("un solo camino de emisión: Admin y worker usan el mismo servicio; nadie llama a FECAESolicitar directo", () => {
  const adminRoute = read("app/api/admin/orders/[id]/invoice/route.ts")
  const cron = read("app/api/cron/arca-invoices/route.ts")
  assert.match(adminRoute, /requireAdmin\(request\)/)
  assert.match(adminRoute, /processArcaInvoice\(auth\.admin, \{[\s\S]*orderId,\s*manual: true,/)
  assert.doesNotMatch(adminRoute, /fecaeSolicitar|begin_arca_invoice_processing|\.update\(/)
  assert.match(cron, /isCronRequestAuthorized\(request\.headers\.get\("authorization"\), process\.env\.CRON_SECRET\)/)
  assert.match(cron, /ARCA_AUTO_INVOICING_ENABLED\?\.trim\(\)\.toLowerCase\(\) !== "true"/)
  assert.match(cron, /processArcaInvoiceQueue\(admin,/)
  const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string }> }
  assert.ok(!vercel.crons.some((cron) => cron.path === "/api/cron/arca-invoices"))

  // fecaeSolicitar sólo lo usa el gateway del servicio.
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const path = join(dir, entry)
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        const source = read(path)
        if (/fecaeSolicitar\(|claim_arca_invoice|processArcaInvoice\(/.test(source)) offenders.push(path.replace(/\\/g, "/"))
      }
    }
  }
  ;["app", "components", "context", "hooks", "lib"].forEach(walk)
  assert.deepEqual(offenders.sort(), [
    // La NC ya no llama a WSFE directo: usa lib/arca/credit-note-emission.ts.
    "app/api/admin/orders/[id]/invoice/route.ts",
    "lib/arca/fixtures/arca-invoicing-db.ts",
    "lib/arca/invoice-automation.ts",
    "lib/arca/wsfe-invoice-gateway.ts",
    "lib/arca/wsfe.ts",
    // Resolución financiera: Factura C antes de la NC y del reintegro, con el
    // mismo servicio y el mismo camino manual que el botón de Admin.
    "lib/orders/financial-resolution-server.ts",
  ])
  const resolution = read("lib/orders/financial-resolution-server.ts")
  assert.match(resolution, /processArcaInvoice\(admin, \{[\s\S]*orderId,\s*manual: true,/)
  assert.doesNotMatch(resolution, /fecaeSolicitar|claim_arca_invoice/)
  // Ninguna pantalla (cliente o Admin) dispara la facturación por su cuenta.
  assert.ok(offenders.every((path) => !/^(components|context|hooks)\//.test(path) && !/\.tsx$/.test(path)))
})

test("ambiente ARCA: sólo explícito; sin valor o con otro valor es error (sin fallback a homologación)", () => {
  const wsfe = read("lib/arca/wsfe.ts")
  const wsaa = read("lib/arca/wsaa.ts")
  // Fuente única (lib/arca/environment.ts) y guard central (configuration.ts).
  assert.match(wsfe, /return getConfiguredArcaEnvironment\(\)/)
  assert.match(wsaa, /arcaFetch\(WSAA_URLS\[configuration\.environment\]/)
  assert.match(wsfe, /arcaFetch\(WSFE_URLS\[configuration\.environment\]/)
  assert.match(wsfe, /arcaFetch\(WSFE_URLS\[environment\]/)
  for (const value of [undefined, "", "   ", "prod", "produccion", "PRODUCCIÓN", "Production", "homologacion", "test"]) {
    assert.throws(() => getConfiguredArcaEnvironment(value), ArcaConfigurationError, String(value))
  }
  assert.equal(getConfiguredArcaEnvironment("homologation"), "homologation")
  assert.equal(getConfiguredArcaEnvironment(" production "), "production")
  assert.match(wsfe, /production: WSFE_PRODUCTION_URL/)
  assert.match(wsaa, /production: "https:\/\/wsaa\.afip\.gov\.ar\/ws\/services\/LoginCms"/)
  assert.doesNotMatch(wsfe, /arcaFetch\(WSFE_HOMOLOGATION_URL/)
  assert.doesNotMatch(wsaa, /arcaFetch\(WSAA_HOMOLOGATION_URL/)
  // Sólo un rechazo explícito de ARCA libera el número pedido.
  assert.match(wsfe, /\], errors\.length > 0\)/)
  assert.match(wsfe, /\], resultCode === "R"\)/)
})

test("cliente: sólo ve y descarga una factura AUTORIZADA de un pedido propio", () => {
  const route = read("app/api/orders/[id]/invoice/route.ts")
  assert.match(route, /\.eq\("usuario_id", user\.id\)/)
  assert.match(route, /if \(!user\) \{[\s\S]*status: 401/)
  assert.match(route, /order\.invoice_status !== "authorized"/)
  assert.match(route, /"Cache-Control": "private, no-store"/)
  const utils = read("lib/account/account-utils.ts")
  assert.match(utils, /export function isInvoiceAvailable\(order: Pick<SupabasePedido, "invoice_status">\) \{\s*return order\.invoice_status === "authorized"/)
})

test("Admin: estado fiscal separado del pago (pendiente / facturando / error con reintento / sin encolar)", () => {
  assert.equal(getInvoiceFiscalStatusView({ invoice_status: "authorized", invoice_cae: "1" }), null)
  assert.equal(getInvoiceFiscalStatusView({ invoice_status: "pending" })?.title, "Pago confirmado · Facturación pendiente")
  assert.equal(getInvoiceFiscalStatusView({ invoice_status: "processing" })?.state, "processing")
  const errorOrder = {
    invoice_status: "error",
    invoice_error: "WSFEv1 rechazó FECAESolicitar: HTTP 503.",
    invoice_next_attempt_at: "2026-09-27T18:10:00.000Z",
    invoice_requested_number: 12,
  }
  const error = getInvoiceFiscalStatusView(errorOrder, true)
  assert.equal(error?.state, "error")
  assert.match(error?.description ?? "", /Se reintenta automáticamente desde el 27\/09 a las 15:10\./)
  // Con el automático apagado nunca promete un reintento automático.
  const errorOff = getInvoiceFiscalStatusView(errorOrder, false)
  assert.doesNotMatch(errorOff?.description ?? "", /Se reintenta automáticamente/)
  assert.match(errorOff?.description ?? "", /facturación automática está desactivada/)
  assert.match(errorOff?.description ?? "", /verifica en ARCA antes de pedir otro número/)
  assert.match(getInvoiceFiscalStatusView({ invoice_status: "pending" }, true)?.description ?? "", /se emite automáticamente/)
  assert.doesNotMatch(getInvoiceFiscalStatusView({ invoice_status: "pending" }, false)?.description ?? "", /se emite automáticamente/)
  assert.match(getInvoiceFiscalStatusView({ invoice_status: "pending" })?.description ?? "", /facturación automática está desactivada/)
  assert.match(error?.description ?? "", /verifica en ARCA antes de pedir otro número/)
  assert.equal(error?.detail, "WSFEv1 rechazó FECAESolicitar: HTTP 503.")
  const manual = getInvoiceFiscalStatusView({ invoice_status: "error", invoice_next_attempt_at: null })
  assert.match(manual?.description ?? "", /requiere revisión/)
  assert.equal(getInvoiceFiscalStatusView({ invoice_status: null })?.state, "not_queued")

  const admin = read("app/admin/sections/pedidos/admin-pedidos.tsx")
  assert.match(admin, /<InvoiceFiscalStatus pedido=\{pedido\} \/>/)
  // El texto usa el mismo dato que el cron (control real + cola), no una suposición.
  assert.match(admin, /getInvoiceFiscalStatusView\(pedido, pedido\.admin_pending_facts\?\.invoiceAutomatic === true\)/)
  // El cron apagado nunca es silencioso: informa ventas pagadas sin Factura C.
  const cron = read("app/api/cron/arca-invoices/route.ts")
  assert.match(cron, /ARCA_AUTO_INVOICING_DISABLED_WITH_PENDING/)
  assert.match(cron, /pendingInvoices/)
  assert.match(admin, /pedido\.invoice_status === "error"\s*\?\s*"Reintentar facturación"/)
})

test("migración: predicado único, trigger después de los guardianes, sin backfill masivo y RPCs sólo service_role", () => {
  const migration = read("supabase/migrations/20260927100000_arca_automatic_invoicing.sql")
  assert.match(migration, /create trigger zz_queue_arca_invoice\s+before insert or update on public\.ordenes/)
  assert.match(migration, /public\.inventory_order_consumes_stock\(p_order\.estado, p_order\.payment_status\)/)
  assert.match(migration, /p_order\.financial_status = 'payment_confirmed'/)
  assert.doesNotMatch(migration, /^update public\.ordenes o\s+set invoice_status = 'pending'/m)
  for (const fn of ["claim_arca_invoice", "record_arca_invoice_request", "complete_arca_invoice", "fail_arca_invoice_attempt"]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`))
    assert.match(migration, new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role;`))
  }
  assert.match(migration, /revoke all on function public\.begin_arca_invoice_processing\(bigint\) from public, anon, authenticated/)
})
