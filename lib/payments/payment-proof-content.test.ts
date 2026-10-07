import assert from "node:assert/strict"
import test from "node:test"
import { PDFDocument, PDFName } from "pdf-lib"

import { isValidPaymentProofContent } from "./payment-proof-content.ts"
import { getPaymentProofValidationError } from "./transfer.ts"

test("un comprobante con MIME y extensión falsos no supera la firma de bytes", async () => {
  const html = new TextEncoder().encode("<script>alert(1)</script>")
  assert.equal(await isValidPaymentProofContent(html, "application/pdf"), false)
  assert.equal(await isValidPaymentProofContent(html, "image/png"), false)
  assert.equal(await isValidPaymentProofContent(html, "image/jpeg"), false)
})

test("un PDF válido se acepta y un PDF con acción activa se rechaza", async () => {
  const safe = await PDFDocument.create()
  safe.addPage()
  assert.equal(await isValidPaymentProofContent(await safe.save(), "application/pdf"), true)

  const active = await PDFDocument.create()
  active.addPage()
  active.catalog.set(PDFName.of("OpenAction"), active.context.obj({ S: PDFName.of("JavaScript"), JS: "app.alert('x')" }))
  assert.equal(await isValidPaymentProofContent(await active.save(), "application/pdf"), false)
})

test("MIME y extensión deben corresponder; archivos vacíos se rechazan", () => {
  assert.notEqual(getPaymentProofValidationError(new File(["x"], "archivo.jpg", { type: "application/pdf" })), "")
  assert.notEqual(getPaymentProofValidationError(new File([], "archivo.png", { type: "image/png" })), "")
})
