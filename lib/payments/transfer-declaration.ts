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

export type TransferDeclarationField = "firstName" | "lastName" | "document" | "amount"

export const TRANSFER_DECLARATION_ERRORS: Record<TransferDeclarationField, string> = {
  firstName: "Indicá el nombre del titular de la cuenta.",
  lastName: "Indicá el apellido del titular de la cuenta.",
  document: "Indicá un DNI (7 u 8 dígitos) o CUIT/CUIL (11 dígitos) válido del titular.",
  amount: "Indicá el monto exacto transferido (mayor a cero, hasta 2 decimales).",
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

/** Trim + espacios internos colapsados; acepta cualquier letra Unicode. */
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
  }

  const lastName = normalizeTransferHolderName(input.apellido)
  if (!lastName || lastName.length > TRANSFER_HOLDER_NAME_MAX_LENGTH) {
    errors.lastName = TRANSFER_DECLARATION_ERRORS.lastName
  }

  const rawDocument =
    typeof input.dni === "string" ? input.dni : typeof input.dni === "number" ? String(input.dni) : null
  const document = parseDeclaredPayerDocument(rawDocument)
  if (!document) errors.document = TRANSFER_DECLARATION_ERRORS.document

  const amount = parseTransferDeclaredAmount(input.monto)
  if (amount == null) errors.amount = TRANSFER_DECLARATION_ERRORS.amount

  if (Object.keys(errors).length > 0 || !document || amount == null) {
    return { ok: false, errors }
  }

  return { ok: true, value: { firstName, lastName, document: document.number, amount } }
}
