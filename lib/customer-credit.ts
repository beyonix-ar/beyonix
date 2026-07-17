export const CUSTOMER_CREDIT_LABEL = "Saldo a favor BEYONIX"

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

export function normalizeMoney(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return 0

  const parsed = Number(String(value).replace(/\./g, "").replace(",", "."))

  if (!Number.isFinite(parsed) || parsed <= 0) return 0

  return roundMoney(parsed)
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
