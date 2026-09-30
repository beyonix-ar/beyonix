import { parseMoneyAmount } from "../customer-credit.ts"
import { parseDeclaredPayerDocument } from "./argentine-identification.ts"

/**
 * Datos que el cliente declara sobre la transferencia: SIEMPRE los del
 * titular de la cuenta bancaria o billetera desde donde salió el dinero
 * (puede no ser quien hizo la compra). Misma validación en el formulario y
 * en /api/transferencia/[orderId]/verificar -- el servidor nunca confía en
 * el cliente.
 */

export const TRANSFER_HOLDER_NAME_MAX_LENGTH = 200
/** CUIT/CUIL: 11 dígitos; DNI: 7-8 (ver parseDeclaredPayerDocument). */
export const TRANSFER_DOCUMENT_MAX_DIGITS = 11

export type TransferDeclarationField = "firstName" | "lastName" | "document" | "amount"

export const TRANSFER_DECLARATION_ERRORS: Record<TransferDeclarationField, string> = {
  firstName: "Indicá el nombre del titular de la cuenta.",
  lastName: "Indicá el apellido del titular de la cuenta.",
  document: "Indicá un DNI (7 u 8 dígitos) o CUIT/CUIL (11 dígitos) válido del titular.",
  amount: "Indicá el monto exacto transferido (mayor a cero, hasta 2 decimales).",
}

export const TRANSFER_HOLDER_NAME_FORMAT_ERRORS: Record<"firstName" | "lastName", string> = {
  firstName: "El nombre sólo puede tener letras, espacios, apóstrofe o guion.",
  lastName: "El apellido sólo puede tener letras, espacios, apóstrofe o guion.",
}

/**
 * Nombre/apellido del titular: letras del alfabeto latino (con tildes, ñ,
 * diéresis y marcas combinantes: "María", "Núñez", "Müller") en palabras
 * separadas por UN espacio, apóstrofe ("O'Connor") o guion ("Ana-María").
 * Sin dígitos ni símbolos; nunca empieza ni termina con un separador.
 */
const TRANSFER_HOLDER_NAME_PATTERN = /^\p{Script=Latin}\p{M}*(?:[ '’-]?\p{Script=Latin}\p{M}*)*$/u
/** Caracteres que pueden escribirse en el campo (el orden se valida al enviar). */
const TRANSFER_HOLDER_NAME_DISALLOWED_CHARS = /[^\p{Script=Latin}\p{M} '’-]/gu

export function isValidTransferHolderName(value: string) {
  return TRANSFER_HOLDER_NAME_PATTERN.test(value)
}

/**
 * Mientras se escribe o pega: descarta dígitos y símbolos sin mostrar un
 * error por tecla. No quita tildes ni cambia letras válidas.
 */
export function sanitizeTransferHolderNameInput(value: string) {
  return value.replace(TRANSFER_HOLDER_NAME_DISALLOWED_CHARS, "")
}

/** Mientras se escribe o pega: sólo dígitos, hasta 11 (CUIT/CUIL). */
export function sanitizeTransferDocumentInput(value: string) {
  return value.replace(/\D/g, "").slice(0, TRANSFER_DOCUMENT_MAX_DIGITS)
}

export interface TransferDeclaration {
  firstName: string
  lastName: string
  /** DNI con 8 dígitos o CUIT/CUIL con 11 (ver parseDeclaredPayerDocument). */
  document: string
  amount: number
}

export type TransferDeclarationResult =
  | { ok: true; value: TransferDeclaration }
  | { ok: false; errors: Partial<Record<TransferDeclarationField, string>> }

/** Trim + espacios internos colapsados; nunca quita tildes ni cambia letras. */
export function normalizeTransferHolderName(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}

/**
 * Monto en pesos con el parser canónico (acepta número JSON y texto es-AR),
 * estrictamente positivo y con hasta 2 decimales. Un número JSON con más
 * decimales se rechaza en vez de redondearse en silencio.
 */
export function parseTransferDeclaredAmount(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
      return null
    }
  }
  const amount = parseMoneyAmount(value)
  return amount != null && amount > 0 ? amount : null
}

export function validateTransferDeclaration(input: {
  nombre?: unknown
  apellido?: unknown
  dni?: unknown
  monto?: unknown
}): TransferDeclarationResult {
  const errors: Partial<Record<TransferDeclarationField, string>> = {}

  const firstName = normalizeTransferHolderName(input.nombre)
  if (!firstName || firstName.length > TRANSFER_HOLDER_NAME_MAX_LENGTH) {
    errors.firstName = TRANSFER_DECLARATION_ERRORS.firstName
  } else if (!isValidTransferHolderName(firstName)) {
    errors.firstName = TRANSFER_HOLDER_NAME_FORMAT_ERRORS.firstName
  }

  const lastName = normalizeTransferHolderName(input.apellido)
  if (!lastName || lastName.length > TRANSFER_HOLDER_NAME_MAX_LENGTH) {
    errors.lastName = TRANSFER_DECLARATION_ERRORS.lastName
  } else if (!isValidTransferHolderName(lastName)) {
    errors.lastName = TRANSFER_HOLDER_NAME_FORMAT_ERRORS.lastName
  }

  // Entrada del titular: SÓLO dígitos. Una llamada directa con letras,
  // espacios o separadores ("37281292ABC", "30.111.222") se rechaza en vez
  // de recortarse en silencio; el formulario ya envía sólo dígitos.
  const rawDocument =
    typeof input.dni === "string"
      ? input.dni.trim()
      : typeof input.dni === "number" && Number.isSafeInteger(input.dni) && input.dni >= 0
        ? String(input.dni)
        : null
  const document =
    rawDocument && /^\d+$/.test(rawDocument) ? parseDeclaredPayerDocument(rawDocument) : null
  if (!document) errors.document = TRANSFER_DECLARATION_ERRORS.document

  const amount = parseTransferDeclaredAmount(input.monto)
  if (amount == null) errors.amount = TRANSFER_DECLARATION_ERRORS.amount

  if (Object.keys(errors).length > 0 || !document || amount == null) {
    return { ok: false, errors }
  }

  return { ok: true, value: { firstName, lastName, document: document.number, amount } }
}
