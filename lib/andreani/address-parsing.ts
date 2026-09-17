import { ANDREANI_STREET_NUMBER_MAX_DIGITS } from "./shipment-limits.ts"

// Sin "server-only": lo usan tanto order-shipment.ts (creación real del
// envío) como checkout-order-creation.ts (bloqueo temprano en checkout,
// ANTES de crear la orden) -- mismo parser, un solo lugar.
const STREET_NUMBER_PATTERN = new RegExp(
  `^(.*\\S)\\s+(\\d{1,${ANDREANI_STREET_NUMBER_MAX_DIGITS}}\\s*(?:bis)?)$`,
  "i",
)
const FLOOR_PATTERN = /\bpiso\s*n?°?\s*:?\s*([0-9a-záéíóúñ]+)/i
const APARTMENT_PATTERN =
  /\b(?:depto|dpto|departamento|apto|apartamento)\s*n?°?\s*:?\s*([0-9a-záéíóúñ]+)/i

export interface ParsedStreetAddress {
  calle: string
  numero: string
  piso?: string
  departamento?: string
}

/**
 * BEYONIX persiste la dirección de checkout como texto libre en un único
 * campo. Andreani B2C exige calle/numero (y opcionalmente piso/depto) por
 * separado, así que este parser hace una extracción best-effort sin tocar
 * el checkout congelado. `numero` queda vacío ("") cuando la altura no se
 * puede identificar CON HASTA `ANDREANI_STREET_NUMBER_MAX_DIGITS` dígitos --
 * nunca inventa un número, y una altura más larga (ej. 7 dígitos) se trata
 * igual que "no tiene altura".
 */
export function parseArgentineStreetAddress(raw: string): ParsedStreetAddress {
  const normalized = raw.trim().replace(/\s+/g, " ")
  const [mainSegment, ...extraSegments] = normalized
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
  const extraText = extraSegments.join(" ")

  const floorMatch = extraText.match(FLOOR_PATTERN) ?? normalized.match(FLOOR_PATTERN)
  const apartmentMatch =
    extraText.match(APARTMENT_PATTERN) ?? normalized.match(APARTMENT_PATTERN)

  const streetSource = (mainSegment ?? normalized)
    .replace(FLOOR_PATTERN, "")
    .replace(APARTMENT_PATTERN, "")
    .trim()
  const numberMatch = streetSource.match(STREET_NUMBER_PATTERN)

  return {
    calle: (numberMatch ? numberMatch[1] : streetSource).trim(),
    numero: numberMatch?.[2]?.trim() ?? "",
    piso: floorMatch?.[1],
    departamento: apartmentMatch?.[1],
  }
}
