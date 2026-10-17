import assert from "node:assert/strict"
import test from "node:test"
import { PDFDocument } from "pdf-lib"

import { batchPdfFilename, buildBatchLabelsPdf } from "./batch-label-pdf.ts"
import { dispatchPdfFilename } from "./labels-document.ts"

test("nombres de PDF: pedido, DSP y varios Bultos generales", () => {
  assert.equal(dispatchPdfFilename("BX-1006"), "BX-1006.pdf")
  assert.equal(batchPdfFilename(["DSP-20261016-001"]), "DSP-20261016-001.pdf")
  assert.equal(batchPdfFilename(["DSP-20261016-001", "DSP-20261016-002"]), "Bultos-generales-DSP-20261016-001-2.pdf")
})

test("Guardar PDF genera etiqueta térmica neutra independiente del diálogo de impresión", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
  const originalImage = globalThis.Image
  const originalDocument = globalThis.document
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  class FakeImage {
    naturalWidth = 100
    naturalHeight = 30
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_: string) { queueMicrotask(() => this.onload?.()) }
  }
  try {
    Object.assign(globalThis, { Image: FakeImage, document: { createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ fillStyle: "", fillRect: () => {}, drawImage: () => {} }),
      toDataURL: () => png,
    }) } })
    URL.createObjectURL = () => "blob:barcode-test"
    URL.revokeObjectURL = () => {}
    const bytes = await buildBatchLabelsPdf(["DSP-20261016-001"], { "DSP-20261016-001": "<svg></svg>" }, "single")
    const pdf = await PDFDocument.load(bytes)
    assert.equal(pdf.getPageCount(), 1)
    assert.ok(Math.abs(pdf.getPage(0).getWidth() - 76 * 72 / 25.4) < 0.1)
    assert.ok(Math.abs(pdf.getPage(0).getHeight() - 40 * 72 / 25.4) < 0.1)
  } finally {
    Object.assign(globalThis, { Image: originalImage, document: originalDocument })
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})
