// Lector de códigos de la cámara de Despachos. Una sola interfaz para todos
// los navegadores: el escáner de cámara no sabe qué motor decodifica.
//   * BarcodeDetector nativo (Chrome/Edge en Android y escritorio).
//   * ZXing en JavaScript (Safari/iPhone y cualquier navegador sin el API),
//     cargado bajo demanda: Android nunca lo descarga.

export type BarcodeReader = {
  kind: "native" | "fallback"
  /** Código legible en el cuadro actual, o null. Nunca lanza por un cuadro ilegible. */
  detect(source: HTMLVideoElement): Promise<string | null>
}

// Etiquetas BEYONIX (Code 128) y códigos de fabricante habituales.
export const READER_FORMATS = ["code_128", "ean_13", "ean_8", "upc_a", "upc_e", "code_39", "itf", "qr_code"]

// API nativa: no está en lib.dom de TypeScript; se tipa sólo lo que se usa.
type DetectedBarcode = { rawValue: string }
type BarcodeDetectorInstance = { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> }
type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance
  getSupportedFormats?: () => Promise<string[]>
}

function nativeConstructor(scope: object): BarcodeDetectorConstructor | null {
  const candidate: unknown = Reflect.get(scope, "BarcodeDetector")
  return typeof candidate === "function" ? candidate as BarcodeDetectorConstructor : null
}

async function nativeReader(Detector: BarcodeDetectorConstructor): Promise<BarcodeReader | null> {
  const supported = await Detector.getSupportedFormats?.().catch(() => null)
  const formats = supported ? READER_FORMATS.filter((format) => supported.includes(format)) : READER_FORMATS
  // Hay Chrome con el API pero sin formatos lineales: mejor el fallback.
  if (supported && !formats.includes("code_128")) return null
  const detector = new Detector({ formats })
  return {
    kind: "native",
    async detect(source) {
      try {
        const found = await detector.detect(source)
        return found.find((item) => item.rawValue.trim())?.rawValue ?? null
      } catch { return null }
    },
  }
}

export async function loadFallbackReader(): Promise<BarcodeReader> {
  const { createZxingReader } = await import("./zxing-barcode-reader")
  return createZxingReader()
}

/** Nativo si el navegador lo soporta; si no, el decodificador JavaScript. */
export async function createBarcodeReader(scope: object = globalThis, loadFallback: () => Promise<BarcodeReader> = loadFallbackReader): Promise<BarcodeReader> {
  const Detector = nativeConstructor(scope)
  const native = Detector ? await nativeReader(Detector).catch(() => null) : null
  return native ?? loadFallback()
}
