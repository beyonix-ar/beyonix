import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Contratos de rutas y UI del aislamiento homologación / producción
// (20260927120000). El render real de Admin está en
// lib/admin/admin-orders-visual.browser.test.tsx; el PDF en
// lib/arca/invoice-pdf-environment.test.ts.

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

test("gateway: el ambiente persistido es el mismo con el que se eligen los endpoints", () => {
  const gateway = read("lib/arca/wsfe-invoice-gateway.ts")
  assert.match(gateway, /environment: getArcaEnvironment\(\)/)
  const wsfe = read("lib/arca/wsfe.ts")
  assert.match(wsfe, /WSFE_URLS\[getArcaEnvironment\(\)\]/)
  const wsaa = read("lib/arca/wsaa.ts")
  assert.match(wsaa, /ARCA_ENV\?\.trim\(\)\.toLowerCase\(\) === "production"/)
})

test("Admin NC: otro ambiente se rechaza ANTES de reservar importes y el ambiente viaja a la emisión", () => {
  const route = read("app/api/admin/orders/[id]/credit-note/route.ts")
  assert.match(route, /invoice_arca_environment/)
  const guard = route.indexOf("if (invoiceEnvironment !== currentEnvironment)")
  const reservation = route.indexOf('.rpc("begin_partial_credit_note"')
  assert.ok(guard > 0 && reservation > guard, "el corte ocurre antes de begin_partial_credit_note")
  assert.match(route, /associatedInvoice: \{\n\s+environment: invoiceEnvironment,/)
})

test("PDF Admin y Mis compras: el ambiente de la factura y de la NC llega al generador", () => {
  for (const path of ["app/api/admin/orders/[id]/invoice/pdf/route.ts", "app/api/orders/[id]/invoice/route.ts"]) {
    const route = read(path)
    assert.match(
      route,
      /arca_environment: isCreditNote\n\s+\? creditNoteRecord\?\.arca_environment \?\? null\n\s+: order\.invoice_arca_environment \?\? null,/,
      path,
    )
  }
})

test("Mis compras: la API expone el ambiente y la compra muestra el aviso de prueba", () => {
  const api = read("app/api/orders/[id]/route.ts")
  assert.match(api, /invoice_arca_environment/)
  const client = read("app/cuenta/cuenta-client.tsx")
  assert.match(
    client,
    /\{invoiceAvailable && !isFiscalArcaVoucher\(order\.invoice_arca_environment\) && \(/,
  )
  assert.match(client, /\{ARCA_TEST_VOUCHER_LABEL\}/)
})

test("Admin: factura y NC de prueba se identifican en el panel de facturación", () => {
  const admin = read("app/admin/sections/pedidos/admin-pedidos.tsx")
  assert.match(admin, /const testInvoice = invoiceIssued && !isFiscalArcaVoucher\(pedido\.invoice_arca_environment\)/)
  assert.match(admin, /testInvoice \? "Factura de prueba" : "Factura emitida"/)
  assert.match(admin, /!isFiscalArcaVoucher\(note\.arca_environment\) && " · prueba"/)
})
