import assert from "node:assert/strict"
import test from "node:test"
import { inflateSync } from "node:zlib"

import { generateInvoicePdf, invoicePdfFilename, type InvoicePdfOrder } from "./invoice-pdf"

// PDF de Factura C / NC: un comprobante de homologación nunca se presenta
// como fiscal (marca de agua, leyenda y nombre de archivo).

process.env.ARCA_CUIT = "20372812924"

const baseOrder: InvoicePdfOrder = {
  id: 12,
  total: 900,
  cliente_nombre: "María Núñez",
  invoice_number: 74,
  invoice_point: 1,
  invoice_cae: "86390927873264",
  invoice_cae_due: "2026-10-05",
  invoice_created_at: "2026-09-25T12:26:29.294Z",
  arca_environment: "homologation",
  orden_items: [{ cantidad: 1, precio: 900, productos: { nombre: "Trípode" } }],
}

/** Texto de todas las páginas (streams Flate) en minúsculas. */
async function pdfContent(order: InvoicePdfOrder) {
  const raw = Buffer.from(await generateInvoicePdf(order)).toString("latin1")
  const decoded: string[] = []
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      decoded.push(inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"))
    } catch {
      decoded.push(match[1])
    }
  }
  return decoded.join("\n").toLowerCase()
}

/** pdf-lib escribe el texto de fuentes estándar como hex WinAnsi. */
const hex = (text: string) => Buffer.from(text, "latin1").toString("hex").toLowerCase()

/** El único bitmap del comprobante es el QR fiscal. */
async function embeddedImages(order: InvoicePdfOrder) {
  const raw = Buffer.from(await generateInvoicePdf(order)).toString("latin1")
  return raw.match(/\/Subtype\s*\/Image/g)?.length ?? 0
}

test("homologación: sin QR fiscal (ningún bitmap) y con recuadro 'SIN QR FISCAL'", async () => {
  assert.equal(await embeddedImages(baseOrder), 0)
  assert.equal(await embeddedImages({ ...baseOrder, arca_environment: null }), 0)
  const content = await pdfContent(baseOrder)
  assert.ok(content.includes(hex("SIN QR")) && content.includes(hex("FISCAL")))
})

test("producción: QR fiscal sólo con CAE real; un CAE inválido no genera un PDF fiscal incompleto", async () => {
  assert.equal(await embeddedImages({ ...baseOrder, arca_environment: "production" }), 1)
  await assert.rejects(
    generateInvoicePdf({ ...baseOrder, arca_environment: "production", invoice_cae: "123" }),
    /faltan datos válidos de autorización de ARCA/,
  )
  // Homologación con CAE raro igual se genera (no hay QR que construir).
  assert.equal(await embeddedImages({ ...baseOrder, invoice_cae: "123" }), 0)
})

test("Factura C de homologación: marca de agua, leyenda de prueba y archivo PRUEBA-", async () => {
  const content = await pdfContent(baseOrder)
  assert.ok(content.includes(hex("SIN VALIDEZ FISCAL - PRUEBA ARCA HOMOLOGACIÓN")), "marca de agua")
  assert.ok(content.includes(hex("COMPROBANTE DE PRUEBA - ARCA HOMOLOGACIÓN")), "recuadro de autorización")
  assert.ok(!content.includes(hex("COMPROBANTE AUTORIZADO")), "nunca como autorizado fiscal")
  assert.ok(!content.includes(hex("El QR permite constatar este comprobante en ARCA.")))
  assert.equal(invoicePdfFilename(baseOrder), "PRUEBA-Factura-BEYONIX-0001-00000074.pdf")
})

test("sin ambiente registrado también es prueba (nunca se asume fiscal)", async () => {
  const order = { ...baseOrder, arca_environment: null }
  const content = await pdfContent(order)
  assert.ok(content.includes(hex("SIN VALIDEZ FISCAL - PRUEBA ARCA HOMOLOGACIÓN")))
  assert.match(invoicePdfFilename(order), /^PRUEBA-/)
})

test("Factura C y NC de producción: sin marcas de prueba, comprobante autorizado", async () => {
  const invoice = { ...baseOrder, arca_environment: "production" }
  const content = await pdfContent(invoice)
  assert.ok(!content.includes(hex("SIN VALIDEZ FISCAL")))
  assert.ok(content.includes(hex("COMPROBANTE AUTORIZADO")))
  assert.ok(content.includes(hex("El QR permite constatar este comprobante en ARCA.")))
  assert.equal(invoicePdfFilename(invoice), "Factura-BEYONIX-0001-00000074.pdf")

  const creditNote = {
    ...invoice,
    voucher_type: 13,
    filename_prefix: "Nota-Credito",
    invoice_number: 10,
    credit_note_for_invoice: { point: 1, number: 74 },
  }
  assert.equal(invoicePdfFilename(creditNote), "Nota-Credito-BEYONIX-0001-00000010.pdf")
  assert.equal(
    invoicePdfFilename({ ...creditNote, arca_environment: "homologation" }),
    "PRUEBA-Nota-Credito-BEYONIX-0001-00000010.pdf",
  )
})
