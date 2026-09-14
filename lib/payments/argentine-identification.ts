/**
 * Deriva un DNI candidato desde payer.identification de Mercado Pago.
 *
 * Mercado Pago NUNCA devuelve payer.first_name/last_name en transferencias
 * directas (comprobado contra la cuenta real, ver auditoría de FASE 1), pero
 * sí devuelve payer.identification (CUIL/CUIT/DNI) de forma consistente. El
 * CUIL/CUIT argentino de persona física codifica el DNI en sus 8 dígitos
 * centrales (formato AA-DDDDDDDD-C, AA = prefijo, C = dígito verificador
 * módulo 11) -- estructura pública y estable de AFIP, no una suposición.
 *
 * Nunca se "corta" el número sin validar: se exige longitud exacta, prefijo
 * de persona física (no CUIT de persona jurídica: 30/33/34) y dígito
 * verificador válido. Cualquier caso inesperado devuelve dni=null en vez de
 * adivinar.
 */

export type ArgentineDniDerivationReason =
  | "missing_identification"
  | "unsupported_identification_type"
  | "unexpected_length"
  | "invalid_checksum"
  | "non_person_prefix"

export interface ArgentineDniDerivationInput {
  type: string | null | undefined
  number: string | null | undefined
}

export interface ArgentineDniDerivationResult {
  /** Tipo original de Mercado Pago, sin modificar. */
  originalType: string | null
  /** Número original de Mercado Pago, sin modificar. */
  originalNumber: string | null
  /** Número normalizado (solo dígitos) usado para derivar el DNI. */
  normalizedNumber: string | null
  /** DNI candidato derivado, o null si no se pudo derivar de forma confiable. */
  dni: string | null
  /** Motivo por el cual no se pudo derivar un DNI, si corresponde. */
  reason: ArgentineDniDerivationReason | null
}

/**
 * Prefijos de CUIL/CUIT de persona física en Argentina. Los CUIT de persona
 * jurídica (30, 33, 34) quedan explícitamente excluidos: nunca deben usarse
 * para derivar el DNI de un pagador individual.
 */
const PERSON_CUIL_PREFIXES = new Set(["20", "23", "24", "25", "26", "27"])

const CUIL_CHECKSUM_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "")
}

/** Algoritmo estándar de dígito verificador de CUIL/CUIT (módulo 11, AFIP). */
export function isValidCuilChecksum(elevenDigits: string): boolean {
  if (!/^\d{11}$/.test(elevenDigits)) return false

  let sum = 0
  for (let i = 0; i < 10; i += 1) {
    sum += Number(elevenDigits[i]) * CUIL_CHECKSUM_WEIGHTS[i]
  }

  const mod = sum % 11
  const verifier = 11 - mod
  const expectedCheckDigit = verifier === 11 ? 0 : verifier === 10 ? null : verifier

  if (expectedCheckDigit === null) return false

  return expectedCheckDigit === Number(elevenDigits[10])
}

export function deriveArgentineDni(
  input: ArgentineDniDerivationInput,
): ArgentineDniDerivationResult {
  const originalType = input.type?.trim() || null
  const originalNumber = input.number?.trim() || null
  const type = originalType?.toUpperCase() ?? ""

  if (!originalType || !originalNumber) {
    return {
      originalType,
      originalNumber,
      normalizedNumber: null,
      dni: null,
      reason: "missing_identification",
    }
  }

  const digits = onlyDigits(originalNumber)

  if (type === "DNI") {
    if (digits.length < 7 || digits.length > 8) {
      return {
        originalType,
        originalNumber,
        normalizedNumber: digits || null,
        dni: null,
        reason: "unexpected_length",
      }
    }

    return {
      originalType,
      originalNumber,
      normalizedNumber: digits,
      dni: digits,
      reason: null,
    }
  }

  if (type === "CUIL" || type === "CUIT") {
    if (digits.length !== 11) {
      return {
        originalType,
        originalNumber,
        normalizedNumber: digits || null,
        dni: null,
        reason: "unexpected_length",
      }
    }

    const prefix = digits.slice(0, 2)
    if (!PERSON_CUIL_PREFIXES.has(prefix)) {
      return {
        originalType,
        originalNumber,
        normalizedNumber: digits,
        dni: null,
        reason: "non_person_prefix",
      }
    }

    if (!isValidCuilChecksum(digits)) {
      return {
        originalType,
        originalNumber,
        normalizedNumber: digits,
        dni: null,
        reason: "invalid_checksum",
      }
    }

    return {
      originalType,
      originalNumber,
      normalizedNumber: digits,
      dni: digits.slice(2, 10),
      reason: null,
    }
  }

  return {
    originalType,
    originalNumber,
    normalizedNumber: digits || null,
    dni: null,
    reason: "unsupported_identification_type",
  }
}

/** DNI informado por el cliente en el formulario: solo dígitos, 7-8 caracteres. */
export function normalizeDeclaredDni(value: string | null | undefined): string | null {
  if (!value) return null
  const digits = onlyDigits(value)
  if (digits.length < 7 || digits.length > 8) return null
  return digits
}
