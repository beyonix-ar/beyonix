import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { inflateSync } from "node:zlib"

import { buildInvoiceDetailLines, generateInvoicePdf, type InvoicePdfOrder } from "./invoice-pdf.ts"
import { fiscalInvoiceTotal, loadFiscalInvoiceTotal, loadFiscalPdfItems } from "./invoice-pdf-data.ts"

const issuedItems = [{ id: 1, producto_id: 10, variante_id: 20, conditioned_name: null, cantidad: 2, precio: 100 }]
const snapshot = [{ order_item_id: 1, quantity: 2, unit_price: 100, product_name: "Camisa original", variant_name: "Azul" }]

function fakeAdmin() {
  let catalogReads = 0
  const admin = {
    from(table: string) {
      if (table === "arca_invoice_header_snapshots") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { fiscal_total: 200 }, error: null }) }) }) }
      }
      if (table === "arca_invoice_item_snapshots") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: snapshot, error: null }) }) }) }
      }
      catalogReads += 1
      throw new Error(`Consulta inesperada al catálogo: ${table}`)
    },
  }
  return { admin: admin as unknown as Parameters<typeof loadFiscalPdfItems>[0], getCatalogReads: () => catalogReads }
}

test("factura emitida conserva descripción, variante, cantidad y precio tras renombrar o eliminar catálogo", async () => {
  const { admin, getCatalogReads } = fakeAdmin()
  const before = await loadFiscalPdfItems(admin, 1, issuedItems)
  // El catálogo puede cambiar o desaparecer: sólo se consulta la captura fiscal.
  const afterRename = await loadFiscalPdfItems(admin, 1, issuedItems)
  const afterDeletion = await loadFiscalPdfItems(admin, 1, [])
  assert.deepEqual(afterRename, before)
  assert.deepEqual(afterDeletion, before)
  assert.equal(getCatalogReads(), 0)
  assert.deepEqual(before, [{ cantidad: 2, precio: 100, productos: { nombre: "Camisa original" }, producto_variantes: { nombre: "Azul" } }])

  const total = await loadFiscalInvoiceTotal(admin, 1, { invoice_requested_total: 200, total: 999 })
  assert.equal(total, 200)
  process.env.ARCA_CUIT = "20372812924"
  const document = {
    id: 1, total, invoice_number: 1, invoice_point: 1, invoice_cae: "86390927873264",
    invoice_cae_due: "2026-10-13", invoice_created_at: "2026-10-03T12:00:00-03:00",
    arca_environment: "production", orden_items: afterDeletion,
  } satisfies InvoicePdfOrder
  const lines = buildInvoiceDetailLines(document)
  assert.equal(lines[0].label, "Camisa original")
  assert.equal(lines[0].detail, "Variante: Azul")
  assert.equal(lines[0].quantity, 2)
  assert.equal(lines.reduce((sum, line) => sum + line.subtotalCents, 0), 20000)
  const raw = Buffer.from(await generateInvoicePdf(document)).toString("latin1")
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap((match) => {
    try { return [inflateSync(Buffer.from(match[1], "latin1")).toString("latin1").toLowerCase()] }
    catch { return [] }
  }).join("\n")
  assert.ok(streams.includes(Buffer.from("Camisa original", "latin1").toString("hex")), "el PDF usa la descripción capturada")
})

test("Admin y cliente usan el mismo detalle capturado y el mismo total fiscal", () => {
  const admin = readFileSync("lib/arca/admin-invoice-pdf.ts", "utf8")
  const client = readFileSync("app/api/orders/[id]/invoice/route.ts", "utf8")
  for (const source of [admin, client]) {
    assert.match(source, /loadFiscalPdfItems\(admin, orderId, itemRows \?\? \[\]\)/)
    assert.match(source, /loadFiscalInvoiceTotal\(admin, orderId, order\)/)
    assert.doesNotMatch(source, /productsById|variantsById/)
  }
  assert.doesNotMatch(admin, /\.from\("profiles"\)/, "el PDF histórico no toma datos de un perfil mutable")
  assert.equal(fiscalInvoiceTotal({ total: 100 }), 100, "compatibilidad para facturas antiguas sin total reservado")
})

test("una instalación anterior a la migración conserva el fallback de catálogo sólo para facturas sin captura", async () => {
  const reads: string[] = []
  const admin = {
    from(table: string) {
      reads.push(table)
      if (table === "arca_invoice_item_snapshots") {
        return { select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { code: "PGRST205" } }) }) }) }
      }
      if (table === "arca_invoice_header_snapshots") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "PGRST205" } }) }) }) }
      }
      const data = table === "productos"
        ? [{ id: 10, nombre: "Nombre aún disponible" }]
        : [{ id: 20, nombre: "Azul" }]
      return { select: () => ({ in: async () => ({ data, error: null }) }) }
    },
  } as unknown as Parameters<typeof loadFiscalPdfItems>[0]
  const items = await loadFiscalPdfItems(admin, 1, issuedItems)
  assert.equal(items[0].productos.nombre, "Nombre aún disponible")
  assert.deepEqual(reads, ["arca_invoice_item_snapshots", "productos", "producto_variantes"])
  assert.equal(await loadFiscalInvoiceTotal(admin, 1, { total: 100 }), 100)
})
