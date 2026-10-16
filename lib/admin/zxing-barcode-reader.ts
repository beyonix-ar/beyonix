// Decodificador JavaScript (ZXing) para navegadores sin BarcodeDetector,
// principalmente Safari en iPhone. Sin WebAssembly ni workers: lee el cuadro
// del video en un canvas y lo decodifica en el hilo principal.
import {
  BarcodeFormat, BinaryBitmap, DecodeHintType, HTMLCanvasElementLuminanceSource,
  HybridBinarizer, MultiFormatReader, type LuminanceSource,
} from "@zxing/library"

import type { BarcodeReader } from "./barcode-reader"

// Cuadro reducido: alcanza para códigos de barras y mantiene fluido un iPhone.
const MAX_FRAME_WIDTH = 960

/** Decodifica un cuadro (luminancia). null si no hay un código legible. */
export function createZxingDecoder() {
  const reader = new MultiFormatReader()
  const hints = new Map<DecodeHintType, unknown>()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.CODE_128, BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E, BarcodeFormat.CODE_39, BarcodeFormat.ITF, BarcodeFormat.QR_CODE,
  ])
  reader.setHints(hints)
  return (source: LuminanceSource) => {
    try {
      return reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source))).getText() || null
    } catch {
      // NotFound/Checksum/Format: cuadro sin código legible.
      return null
    } finally {
      reader.reset()
    }
  }
}

export function createZxingReader(): BarcodeReader {
  const decode = createZxingDecoder()
  const canvas = document.createElement("canvas")
  const context = canvas.getContext("2d", { willReadFrequently: true })
  return {
    kind: "fallback",
    async detect(video) {
      if (!context || !video.videoWidth || !video.videoHeight) return null
      const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth)
      canvas.width = Math.round(video.videoWidth * scale)
      canvas.height = Math.round(video.videoHeight * scale)
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      return decode(new HTMLCanvasElementLuminanceSource(canvas))
    },
  }
}
