export const CUSTOMER_CREDIT_LABEL = "Saldo a favor BEYONIX"
export const MIN_MERCADOPAGO_CUSTOMER_CREDIT_TOPUP = 10_000

export interface CreditApplicationInput {
  availableBalance: number
  eligibleTotal: number
  requestedAmount: number
}

export interface CreditApplicationResult {
  availableBalance: number
  eligibleTotal: number
  requestedAmount: number
  appliedAmount: number
  remainingBalance: number
  externalAmountDue: number
  coversTotal: boolean
}

export type CustomerCreditMovementType =
  | "credit"
  | "debit"
  | "reversal"
  | "adjustment"
  | "expiration"

export interface CustomerCreditMovement {
  id: string
  user_id: string
  movement_type: CustomerCreditMovementType
  amount: number | string
  description: string
  source_type: string
  source_id?: string | null
  order_id?: number | null
  claim_id?: number | null
  credit_note_id?: string | null
  created_by?: string | null
  related_movement_id?: string | null
  expires_at?: string | null
  created_at: string
  metadata?: Record<string, unknown> | null
  source_key?: string | null
  resulting_balance?: number | string | null
}

export function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0

  return Math.round(value * 100) / 100
}

const ES_AR_THOUSANDS_ONLY = /^\d{1,3}(\.\d{3})+$/
const ES_AR_WITH_DECIMAL_COMMA = /^(\d{1,3}(\.\d{3})+|\d+),\d{1,2}$/
const PLAIN_DECIMAL = /^\d+(\.\d{1,2})?$/

/**
 * Parser canónico de montos en PESOS (nunca centavos), redondeado a 2
 * decimales. Única implementación para montos que llegan de un request:
 *
 * - `number` (JSON): se toma tal cual -- `1500.5` es $1.500,50. Antes se
 *   pasaba por `String()` y se borraban los puntos como si fueran miles,
 *   leyendo `1500.5` como $15.005.
 * - `string`, formato es-AR o decimal simple:
 *   "1500", "1500.5", "1500.50", "0.5" (punto decimal con 1-2 dígitos),
 *   "1.500", "1.500.000" (punto de miles, grupos de 3),
 *   "1500,5", "1.500,50" (coma decimal).
 *   Espacios y "$" iniciales se ignoran.
 *
 * Fail-closed: cualquier otra forma (letras, negativos, separadores
 * ambiguos como "1,500.50" o "1.50.0", más de 2 decimales, NaN/Infinity)
 * devuelve `null` -- nunca se "adivina" un monto.
 */
export function parseMoneyAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? roundMoney(value) : null
  }

  if (typeof value !== "string") return null

  const text = value.trim().replace(/^\$\s*/, "")
  if (!text) return null

  let normalized: string | null = null
  if (PLAIN_DECIMAL.test(text)) {
    normalized = text
  } else if (ES_AR_THOUSANDS_ONLY.test(text)) {
    normalized = text.replace(/\./g, "")
  } else if (ES_AR_WITH_DECIMAL_COMMA.test(text)) {
    normalized = text.replace(/\./g, "").replace(",", ".")
  }

  if (normalized == null) return null

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? roundMoney(parsed) : null
}

/**
 * Texto permitido en un input de monto mientras se escribe: sólo dígitos y
 * UN separador decimal (punto o coma) con hasta 2 decimales. Sin letras,
 * signos, "$", espacios ni separadores de miles.
 */
const MONEY_INPUT_PATTERN = /^\d*(?:[.,]\d{0,2})?$/

export function isValidMoneyInput(value: string) {
  return MONEY_INPUT_PATTERN.test(value)
}

/**
 * Monto de un input restringido por isValidMoneyInput: punto y coma son
 * ambos separadores DECIMALES ("1000,10" = "1000.10" = 1000.1). Normaliza y
 * delega en parseMoneyAmount (parser canónico). Texto inválido -> null,
 * nunca un monto "adivinado". Un separador final ("1000,") vale 1000.
 */
export function parseMoneyInput(value: string): number | null {
  if (!MONEY_INPUT_PATTERN.test(value)) return null
  const normalized = value.replace(",", ".").replace(/\.$/, "")
  if (!normalized || normalized === ".") return null
  return parseMoneyAmount(normalized.startsWith(".") ? `0${normalized}` : normalized)
}

/**
 * Monto en PESOS estrictamente positivo, o 0 si no hay un monto válido
 * (contrato histórico de los checkouts: 0 = "no usar saldo").
 */
export function normalizeMoney(value: unknown) {
  const parsed = parseMoneyAmount(value)
  return parsed != null && parsed > 0 ? parsed : 0
}

export function formatARS(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(roundMoney(value))
}

export function getMaxApplicableCustomerCredit(
  availableBalance: number,
  eligibleTotal: number
) {
  return roundMoney(
    Math.min(
      Math.max(availableBalance, 0),
      Math.max(eligibleTotal, 0)
    )
  )
}

export function calculateCustomerCreditApplication({
  availableBalance,
  eligibleTotal,
  requestedAmount,
}: CreditApplicationInput): CreditApplicationResult {
  const safeBalance = roundMoney(Math.max(availableBalance, 0))
  const safeEligibleTotal = roundMoney(Math.max(eligibleTotal, 0))
  const safeRequested = roundMoney(Math.max(requestedAmount, 0))
  const maxApplicable = getMaxApplicableCustomerCredit(
    safeBalance,
    safeEligibleTotal
  )
  const appliedAmount = roundMoney(Math.min(safeRequested, maxApplicable))
  const externalAmountDue = roundMoney(
    Math.max(safeEligibleTotal - appliedAmount, 0)
  )

  return {
    availableBalance: safeBalance,
    eligibleTotal: safeEligibleTotal,
    requestedAmount: safeRequested,
    appliedAmount,
    remainingBalance: roundMoney(Math.max(safeBalance - appliedAmount, 0)),
    externalAmountDue,
    coversTotal: appliedAmount > 0 && externalAmountDue === 0,
  }
}

export function getPaymentComposition(params: {
  paymentMethodId: string
  creditBalanceUsed: number
  externalAmountDue: number
}) {
  const creditBalanceUsed = roundMoney(params.creditBalanceUsed)
  const externalAmountDue = roundMoney(params.externalAmountDue)
  const parts = []

  if (creditBalanceUsed > 0) {
    parts.push({
      type: "customer_credit",
      label: CUSTOMER_CREDIT_LABEL,
      amount: creditBalanceUsed,
    })
  }

  if (externalAmountDue > 0) {
    parts.push({
      type: params.paymentMethodId,
      label:
        params.paymentMethodId === "transferencia"
          ? "Transferencia bancaria"
          : params.paymentMethodId === "mercadopago"
            ? "Mercado Pago"
            : params.paymentMethodId,
      amount: externalAmountDue,
    })
  }

  return {
    credit_balance_used: creditBalanceUsed,
    external_amount_due: externalAmountDue,
    parts,
  }
}
