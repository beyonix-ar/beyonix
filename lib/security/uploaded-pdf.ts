import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from "pdf-lib"

const ACTIVE_PDF_NAMES = new Set([
  "JS", "JavaScript", "OpenAction", "AA", "Launch", "EmbeddedFiles",
  "EmbeddedFile", "RichMedia", "XFA", "SubmitForm", "ImportData",
])

/** Reject malformed PDFs and interactive content before storing customer uploads. */
export async function isSafeUploadedPdf(bytes: Uint8Array): Promise<boolean> {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false })
    if (!document.getPageCount()) return false
    const inspect = (value: unknown): void => {
      if (value instanceof PDFName && ACTIVE_PDF_NAMES.has(value.decodeText())) {
        throw new Error("Active PDF")
      }
      if (value instanceof PDFDict) {
        for (const [key, entry] of value.entries()) { inspect(key); inspect(entry) }
      }
      if (value instanceof PDFArray) {
        for (const entry of value.asArray()) inspect(entry)
      }
      if (value instanceof PDFStream) inspect(value.dict)
    }
    for (const [, object] of document.context.enumerateIndirectObjects()) inspect(object)
    return true
  } catch {
    return false
  }
}
