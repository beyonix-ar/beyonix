import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { isCustomerCreditNoteAvailable, isInvoiceAvailable } from "./account-utils.ts"
import { selectCustomerDisplayedClaim, selectCustomerHistoryClaim } from "../orders/customer-claim-unread.ts"
import { CUSTOMER_ORDER_FIELDS } from "../orders/customer-order-dto.ts"

// Accesos directos de "Mis compras": factura, NC y reclamo sólo cuando
// existen, con la misma regla que el detalle y el endpoint del documento.

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")
const note = { credit_note_status: "authorized" as const, credit_note_number: "8", credit_note_point: 3, credit_note_cae: "456" }
const claim = (id: number, status: string, failure_type: string, created_at = "2026-10-21T12:00:00Z") => ({ id, status, failure_type, created_at })

test("H-K: factura y NC según su autorización real (la NC exige la factura autorizada, como el endpoint)", () => {
  assert.equal(isInvoiceAvailable({ invoice_status: null }), false, "H: sin documentos")
  assert.equal(isInvoiceAvailable({ invoice_status: "processing" }), false)
  assert.equal(isInvoiceAvailable({ invoice_status: "authorized" }), true, "I")
  assert.equal(isCustomerCreditNoteAvailable({ invoice_status: "authorized", ...note }), true, "J/K")
  assert.equal(isCustomerCreditNoteAvailable({ invoice_status: "authorized", ...note, credit_note_status: "processing" }), false, "NC en emisión: todavía no")
  assert.equal(isCustomerCreditNoteAvailable({ invoice_status: "authorized", ...note, credit_note_cae: null }), false)
  assert.equal(isCustomerCreditNoteAvailable({ invoice_status: null, ...note }), false)
  // El detalle usa la misma regla (sin una segunda copia).
  assert.match(source("app/cuenta/cuenta-client.tsx"), /const creditNoteAvailable = isCustomerCreditNoteAvailable\(order\)/)
})

test("L-O: Ver reclamo abre el activo o la última conversación, incluida una consulta cerrada; nunca la cancelación", () => {
  assert.equal(selectCustomerHistoryClaim([]), undefined)
  assert.equal(selectCustomerHistoryClaim([claim(6, "cerrado", "cancelar_compra")]), undefined, "la solicitud de cancelación no es una conversación")
  assert.equal(selectCustomerHistoryClaim([claim(40, "en_revision", "producto_danado")])?.id, 40, "L")
  assert.equal(selectCustomerHistoryClaim([claim(50, "cerrado", "producto_danado")])?.id, 50, "M")
  // N/O: BX-1014 (cancelado) con la consulta cerrada claim 5.
  assert.equal(selectCustomerHistoryClaim([claim(5, "cerrado", "consulta_pedido"), claim(6, "cerrado", "cancelar_compra", "2026-10-22T12:00:00Z")])?.id, 5)
  assert.equal(selectCustomerHistoryClaim([claim(7, "cerrado", "consulta_pedido", "2026-10-22T12:00:00Z"), claim(8, "aprobado", "producto_danado", "2026-10-20T12:00:00Z")])?.id, 8, "el activo primero")
  // La página del reclamo muestra exactamente esa conversación, aunque el pedido entregado permita iniciar otro reclamo.
  const claims = [claim(5, "cerrado", "consulta_pedido")]
  assert.equal(selectCustomerDisplayedClaim(claims, { canCreatePostDeliveryClaim: true }), undefined, "sin elegirla, sigue el flujo de reclamo nuevo")
  assert.equal(selectCustomerDisplayedClaim(claims, { canCreatePostDeliveryClaim: true, preferredClaimId: 5 })?.id, 5)
  assert.equal(selectCustomerDisplayedClaim(claims, { canCreatePostDeliveryClaim: true, preferredClaimId: 99 }), undefined, "un id que no es de este pedido no muestra nada")
  assert.equal(selectCustomerDisplayedClaim([claim(6, "cerrado", "cancelar_compra")], { canCreatePostDeliveryClaim: false, preferredClaimId: 6 }), undefined)
  // O: un pedido cancelado con conversación previa la sigue mostrando.
  assert.match(source("app/cuenta/cuenta-client.tsx"), /\(order\.estado \?\? ""\)\.toLowerCase\(\) === "cancelado" && !hasConversation/)
})

test("P: documentos y reclamos sólo del propio cliente; el listado manda estados, nunca PDF ni URLs", () => {
  const list = source("app/api/orders/route.ts")
  const select = list.match(/const ORDER_LIST_SELECT =\s*\n?\s*"([^"]+)"/)![1]
  for (const field of ["invoice_status", "credit_note_status", "credit_note_number", "credit_note_point", "credit_note_cae", "order_claims(id, status, failure_type"])
    assert.ok(select.includes(field), field)
  assert.doesNotMatch(select, /pdf|_url,? *credit|invoice_pdf|storage/i)
  for (const field of ["invoice_status", "credit_note_status", "credit_note_number", "credit_note_point", "credit_note_cae"])
    assert.ok((CUSTOMER_ORDER_FIELDS as readonly string[]).includes(field), `${field} ya permitido por el DTO del cliente`)
  assert.match(list, /\.eq\("usuario_id", user\.id\)/)
  // Factura y NC: el endpoint exige sesión y titularidad (y 404 para lo ajeno).
  const invoice = source("app/api/orders/[id]/invoice/route.ts")
  assert.match(invoice, /\.eq\("usuario_id", user\.id\)/)
  assert.match(invoice, /\.eq\("order_id", orderId\)/)
  assert.match(invoice, /status: 404/)
  // Reclamos: la página carga los reclamos por la ruta autorizada del pedido; ?claim sólo elige entre ellos.
  const claimsRoute = source("app/api/orders/[id]/claims/route.ts")
  assert.match(claimsRoute, /authorizeOrder\(/)
  const experience = source("components/claims/customer-claim-experience.tsx")
  assert.match(experience, /fetch\(`\/api\/orders\/\$\{order\.id\}\/claims`\)/)
  assert.match(experience, /preferredClaimId: focusClaimId/)
  // Mis compras reutiliza el visor existente (sin otro visor ni descarga directa).
  const orders = source("components/account/account-orders.tsx")
  assert.match(orders, /<InvoiceViewerModal/)
  assert.match(orders, /\/invoice\?type=credit_note/)
  assert.doesNotMatch(orders, /download=|window\.open\(/)
})
