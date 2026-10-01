// Medio REAL con el que se pagó una orden de Checkout Pro, para auditar
// después cómo pagó el cliente frente a la modalidad que eligió en BEYONIX.
//
// Nunca se usa para rechazar ni recalcular un pago aprobado: el monto de la
// preferencia es fijo y ya se validó (monto exacto + moneda). Sólo deja
// trazabilidad. Casos esperables de diferencia en "cuotas" (precio
// financiado): pagar con Dinero en cuenta (Checkout Pro no permite excluirlo)
// o elegir 1 pago dentro de Mercado Pago (Checkout Pro no admite un mínimo).

export type MercadoPagoCheckoutModality = "mercadopago_cash" | "mercadopago_financed"

/** Tipos de pago que corresponden a cada modalidad (ver exclusiones en checkout-pricing.ts). */
const EXPECTED_PAYMENT_TYPES: Record<MercadoPagoCheckoutModality, readonly string[]> = {
  // 1 pago a precio contado: cualquier medio inmediato, crédito incluido.
  mercadopago_cash: ["credit_card", "debit_card", "account_money", "prepaid_card"],
  mercadopago_financed: ["credit_card"],
}

export type MercadoPagoPaymentMedium = {
  /** Tipo de Mercado Pago: credit_card, debit_card, account_money, … */
  payment_type_id: string | null
  /** Medio/marca de Mercado Pago: visa, master, debvisa, account_money, … */
  payment_method_id: string | null
  /** Cuotas reales con las que se procesó el pago. */
  installments: number | null
  /** Modalidad elegida en BEYONIX (null en órdenes previas a este modelo). */
  checkout_modality: MercadoPagoCheckoutModality | null
  /** true/false si el tipo real corresponde a la modalidad; null si no se puede saber. */
  matches_checkout_modality: boolean | null
}

function textOrNull(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

export function toMercadoPagoCheckoutModality(value: unknown): MercadoPagoCheckoutModality | null {
  return value === "mercadopago_cash" || value === "mercadopago_financed" ? value : null
}

export function getMercadoPagoPaymentMedium(
  payment: { payment_type_id?: string | null; payment_method_id?: string | null; installments?: number | null },
  checkoutModality: unknown,
): MercadoPagoPaymentMedium {
  const paymentTypeId = textOrNull(payment.payment_type_id)
  const modality = toMercadoPagoCheckoutModality(checkoutModality)
  const rawInstallments = Number(payment.installments)
  const installments = Number.isInteger(rawInstallments) && rawInstallments > 0 ? rawInstallments : null
  const typeMatches =
    modality && paymentTypeId ? EXPECTED_PAYMENT_TYPES[modality].includes(paymentTypeId) : null

  return {
    payment_type_id: paymentTypeId,
    payment_method_id: textOrNull(payment.payment_method_id),
    installments,
    checkout_modality: modality,
    // Cuotas pagadas en 1 pago: se cobró el precio financiado por un pago
    // único (el cliente tenía "1 pago" a contado en BEYONIX) -> a revisión.
    matches_checkout_modality:
      typeMatches === true && modality === "mercadopago_financed" && installments === 1 ? false : typeMatches,
  }
}
