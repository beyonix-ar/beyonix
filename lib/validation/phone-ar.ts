/**
 * Normalización única de teléfono argentino para toda la web (registro,
 * checkout, Mi Cuenta). Antes cada pantalla implementaba su propio
 * `replace(/\D/g, "")` y el valor se guardaba tal cual lo tipeaba el usuario
 * (con o sin "+54", con o sin el "0" de larga distancia) -- ver auditoría:
 * no existía ningún formato canónico real.
 *
 * Formato canónico (el que se guarda/envía): sólo el número nacional en
 * dígitos, SIN "+54" y SIN el "0" inicial. El "+54" es puramente visual en
 * la UI (components/phone/argentina-phone-input.tsx), nunca forma parte del
 * valor persistido. Esto es compatible con:
 * - lib/clients/client-blocking.ts (normalizeBlockIdentifier) y su gemela
 *   SQL public.normalize_block_identifier(), que ya comparan sólo dígitos.
 * - Andreani (lib/andreani/order-shipment.ts normalizePhoneNumber), que ya
 *   sólo le importan los dígitos y un largo entre 8 y 15.
 *
 * BEYONIX no usa hoy el "9" de celular argentino (E.164 real) en ningún
 * lado -- ver auditoría, ni backend ni Andreani ni Mercado Pago lo agregan o
 * esperan. No se inventa esa regla acá tampoco: sólo se descarta un "9"
 * pegado inmediatamente después de un "+54"/"54" ya detectado como código de
 * país (típico al copiar un número desde WhatsApp o la agenda del
 * teléfono), nunca se toca un "9" que el usuario tipeó como parte del
 * número nacional.
 */

export const ARGENTINA_PHONE_PREFIX = "+54"

export const ARGENTINA_NATIONAL_PHONE_MIN_LENGTH = 8
export const ARGENTINA_NATIONAL_PHONE_MAX_LENGTH = 11

// Largo típico de área + abonado (sin "0", sin "9", sin código de país).
// Se usa sólo como referencia interna para decidir si un "9" pegado justo
// después del código de país es el 9 de formato internacional de WhatsApp/
// agenda -- nunca se expone, porque no es un límite de validación (ese es
// ARGENTINA_NATIONAL_PHONE_MAX_LENGTH, deliberadamente más tolerante).
const TYPICAL_BARE_NATIONAL_LENGTH = 10

/**
 * Convierte cualquier entrada (tipeada o pegada, con espacios, guiones,
 * paréntesis, "+54"/"54" y/o un "0" inicial) al número nacional canónico:
 * sólo dígitos, sin código de país, sin el "0" de larga distancia.
 */
export function normalizeArgentineNationalPhone(raw: string | null | undefined): string {
  let digits = (raw ?? "").replace(/\D/g, "")
  if (!digits) return ""

  // El código de país sólo se pega junto a un número completo -- un número
  // nacional real (8 a 11 dígitos) nunca llega a superar el máximo por sí
  // solo, así que sólo se interpreta "54" como código de país cuando el
  // total pegado excede ese máximo. `while` (no `if`) para nunca dejar
  // "+54+54..." guardado si el usuario llega a pegarlo duplicado.
  let strippedCountryCode = false
  while (digits.startsWith("54") && digits.length > ARGENTINA_NATIONAL_PHONE_MAX_LENGTH) {
    digits = digits.slice(2)
    strippedCountryCode = true
  }

  // Copiar un celular desde WhatsApp/la agenda del teléfono trae el "9" de
  // formato internacional (+54 9 ...), pegado justo después del código de
  // país. Sólo se descarta si YA se detectó y sacó un código de país Y el
  // total sigue superando el largo típico de un número nacional real --
  // nunca toca un "9" que el usuario tipeó a mano como parte del número
  // (ese caso nunca pasa por acá: no hay "54" que disparar la regla).
  if (
    strippedCountryCode &&
    digits.startsWith("9") &&
    digits.length > TYPICAL_BARE_NATIONAL_LENGTH
  ) {
    digits = digits.slice(1)
  }

  // En Argentina ningún código de área empieza con "0" -- ese dígito es
  // siempre el prefijo de larga distancia nacional, nunca parte real del
  // número. `while` por si llega duplicado ("00341...").
  while (digits.startsWith("0")) {
    digits = digits.slice(1)
  }

  return digits.slice(0, ARGENTINA_NATIONAL_PHONE_MAX_LENGTH)
}

export function isValidArgentineNationalPhone(digits: string): boolean {
  return new RegExp(
    `^\\d{${ARGENTINA_NATIONAL_PHONE_MIN_LENGTH},${ARGENTINA_NATIONAL_PHONE_MAX_LENGTH}}$`,
  ).test(digits)
}

export function formatArgentinePhoneForDisplay(canonicalDigits: string): string {
  return `${ARGENTINA_PHONE_PREFIX} ${canonicalDigits}`.trim()
}
