import assert from "node:assert/strict"
import test from "node:test"

import { argentinaToday, fiscalDayBounds, fiscalMonthBounds, fiscalPeriodBounds, fiscalZipName } from "./fiscal-history.ts"
import { createFiscalZipStream } from "./zip-stream.ts"

test("períodos fiscales usan día argentino y año contextual", () => {
  assert.equal(argentinaToday(new Date("2026-10-04T02:30:00Z")), "2026-10-03")
  assert.deepEqual(fiscalDayBounds("2026-10-03"), { from: "2026-10-03", to: "2026-10-04" })
  assert.deepEqual(fiscalMonthBounds(2026, 10), { from: "2026-10-01", to: "2026-11-01" })
  assert.deepEqual(fiscalMonthBounds(2027, 10), { from: "2027-10-01", to: "2027-11-01" })
  assert.deepEqual(fiscalMonthBounds(2026, 12), { from: "2026-12-01", to: "2027-01-01" })
  assert.deepEqual(fiscalPeriodBounds("today", 2027, 10, new Date("2026-10-04T02:30:00Z")), { from: "2026-10-03", to: "2026-10-04" })
  assert.throws(() => fiscalDayBounds("2026-02-30"))
  assert.equal(fiscalZipName("invoice", ["2026-10-03", "2026-10-03"]), "facturas-beyonix-2026-10-03.zip")
  assert.equal(fiscalZipName("credit_note", ["2026-10-03", "2026-10-04"]), "notas-credito-beyonix-2026-10.zip")
})

test("ZIP fiscal transmite PDFs de a uno con directorio y CRC válidos", async () => {
  let generated = 0
  const files = ["Factura-0001.pdf", "Factura-0002.pdf"]
  const bytes = [new TextEncoder().encode("%PDF-primera"), new TextEncoder().encode("%PDF-segunda")]
  const stream = createFiscalZipStream(files.map((name, index) => ({
    document: async () => { generated += 1; return { name, bytes: bytes[index] } },
  })))
  const reader = stream.getReader()
  const first = await reader.read()
  assert.equal(generated, 1, "no genera todos los PDFs antes de transmitir")
  assert.equal(new DataView(first.value!.buffer).getUint32(0, true), 0x04034b50)
  const chunks = [first.value!]
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  assert.equal(generated, 2)
  const all = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  const eocd = all.length - 22
  assert.equal(all.readUInt32LE(eocd), 0x06054b50)
  assert.equal(all.readUInt16LE(eocd + 10), 2)
  const centralOffset = all.readUInt32LE(eocd + 16)
  assert.equal(all.readUInt32LE(centralOffset), 0x02014b50)
  assert.ok(all.includes(Buffer.from("Factura-0001.pdf")))
  assert.ok(all.includes(Buffer.from("Factura-0002.pdf")))
  assert.ok(all.includes(Buffer.from("%PDF-segunda")))
})
