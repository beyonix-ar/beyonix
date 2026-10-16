// Lectura de códigos en Despachos: lector USB (teclado + Enter) y cámara del
// celular terminan en el mismo envío. Acá vive la lógica pura (sin DOM) para
// poder testearla: normalización, anti relectura de cámara y código → pedido.
//
// Doble lectura del lector USB: mientras un escaneo se procesa no se acepta
// otro (busy), cada lectura lleva su request_key (un reintento no suma) y la
// base rechaza unidades de más. Por eso no hay ventana de tiempo: bloquearía
// el reintento legítimo después de un corte de red.

const MAX_CODE_LENGTH = 128

/** Lo que manda un lector: sin espacios ni caracteres de control alrededor. */
export function normalizeScannedCode(raw: string) {
  const code = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return code.length > 0 && code.length <= MAX_CODE_LENGTH ? code : null
}

/**
 * Cámara: mientras el mismo código siga en cuadro no se vuelve a contar. Se
 * rearma recién cuando el código sale de cuadro (varios cuadros sin lectura) o
 * aparece otro distinto. Evita sumar unidades de más con el celular quieto.
 */
export function createCameraGate(emptyFramesToRearm = 3) {
  let current: string | null = null
  let empty = 0
  return (code: string | null) => {
    if (!code) {
      empty += 1
      if (empty >= emptyFramesToRearm) current = null
      return null
    }
    empty = 0
    const key = code.toUpperCase()
    if (key === current) return null
    current = key
    return code
  }
}

/**
 * Pedido al que pertenece un código BEYONIX de despacho: pedido (BX-1006),
 * pedido preparado (BX-PREP-1006, BX-PREP-1006-R2) o bulto (BX-PKG-1006-01).
 */
export function orderIdFromDispatchCode(value: string) {
  const code = value.trim().toUpperCase()
  const match = /^#?BX-(?:PREP-)?(\d+)(?:-R\d+)?$/.exec(code) ?? /^BX-PKG-(\d+)(?:-R\d+)?-\d{2}$/.exec(code)
  if (!match) return null
  const id = Number(match[1]) - 1000
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

// Un lector USB "tipea" el código entero en pocos milisegundos; una persona no.
const SCANNER_MIN_KEYS = 4
const SCANNER_MAX_KEY_INTERVAL_MS = 50

/**
 * Cómo llegó un código al campo de lectura. Sólo se registra para auditoría:
 * todos los métodos terminan en la misma validación del servidor.
 */
export function typedInputMethod(input: { pasted: boolean; keyTimes: readonly number[] }): "scanner" | "manual_code" {
  if (input.pasted || input.keyTimes.length < SCANNER_MIN_KEYS) return "manual_code"
  const intervals = input.keyTimes.slice(1).map((time, index) => time - input.keyTimes[index]).sort((left, right) => left - right)
  const median = intervals[Math.floor(intervals.length / 2)]
  return median <= SCANNER_MAX_KEY_INTERVAL_MS ? "scanner" : "manual_code"
}

/** Porcentaje de avance sin pasar 100 ni mostrar 100 antes de completar. */
export function progressPercent(done: number, total: number) {
  if (total <= 0) return 0
  return Math.min(100, Math.floor((Math.max(0, done) / total) * 100))
}
