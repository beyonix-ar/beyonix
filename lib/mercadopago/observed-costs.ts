import {
  INSTALLMENT_COUNTS,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "../products/installments.ts"

/**
 * Costos de Mercado Pago "observados": se derivan de los pagos aprobados que
 * el webhook ya persiste en `ordenes.mercadopago_payment_snapshot`
 * (fee_details / transaction_amount, dato REAL cobrado por Mercado Pago).
 * Mercado Pago no expone por API la comisión ni el plazo configurados en la
 * cuenta antes de vender, así que la única fuente automática honesta es lo
 * que efectivamente cobró en los últimos pagos.
 *
 * Las tasas observadas incluyen IVA (Mercado Pago no lo discrimina en el
 * pago): se convierten a "sin IVA" con el IVA configurado para mantener el
 * mismo modelo de `InstallmentsFinancingConfig`.
 */

export type MercadoPagoCostsMode = "automatic" | "manual"

export const DEFAULT_MERCADOPAGO_COSTS_MODE: MercadoPagoCostsMode = "manual"

/** Observaciones más viejas que esto no se usan: pueden no reflejar la tasa vigente. */
export const MERCADOPAGO_OBSERVATION_MAX_AGE_DAYS = 90
/** Monto mínimo del pago: por debajo, el redondeo a centavos distorsiona la tasa. */
export const MERCADOPAGO_OBSERVATION_MIN_AMOUNT = 100
/** Pagos recientes que se leen para buscar observaciones. */
export const MERCADOPAGO_OBSERVATION_SAMPLE_SIZE = 50

const MAX_PLAUSIBLE_PERCENT = 60

export interface MercadoPagoObservationSourceRow {
  id: number
  paid_at: string | null
  mercadopago_payment_snapshot: {
    installments?: number | null
    transaction_amount?: number | null
    fee_details?: Array<{ type?: string | null; amount?: number | null }> | null
    charges_details?: Array<{ name?: string | null; rate?: number | null }> | null
    money_release_date?: string | null
    payment_type_id?: string | null
    payment_method_id?: string | null
  } | null
}

export interface MercadoPagoCostObservation {
  /** Tasa cobrada sobre el monto del pago, IVA incluido. */
  percentWithIva: number
  observedAt: string
  paymentTypeId: string | null
  paymentMethodId: string | null
  installments: number
  /** Días entre la aprobación y la liberación del dinero (si Mercado Pago la informó). */
  releaseDays: number | null
  orderId: number
}

/** Medios en 1 pago que se observan por separado (nunca se mezclan). */
export type ObservedSinglePaymentType = "credit_card" | "debit_card" | "account_money"

export interface MercadoPagoObservedCosts {
  /** Comisión base: SÓLO tarjeta de crédito en 1 pago (con lo que se cobra el precio financiado). */
  base: MercadoPagoCostObservation | null
  /** Costo de N cuotas: SÓLO crédito en N cuotas con cargo de financiación. */
  surchargeByCount: Record<InstallmentCount, MercadoPagoCostObservation | null>
  /** Referencia por medio en 1 pago (informativa: no alimenta ningún cálculo salvo crédito → base). */
  singlePaymentByType: Record<ObservedSinglePaymentType, MercadoPagoCostObservation | null>
  /** Pagos aprobados con costo informado que se analizaron. */
  analyzedPayments: number
}

export type MercadoPagoCostSource = "observed" | "manual"

export interface ResolvedInstallmentsFinancing {
  effective: InstallmentsFinancingConfig
  sources: {
    base: MercadoPagoCostSource
    surchargeByCount: Record<InstallmentCount, MercadoPagoCostSource>
  }
}

export function normalizeMercadoPagoCostsMode(value: unknown): MercadoPagoCostsMode {
  return value === "automatic" || value === "manual" ? value : DEFAULT_MERCADOPAGO_COSTS_MODE
}

export function getEmptyMercadoPagoObservedCosts(): MercadoPagoObservedCosts {
  return {
    base: null,
    surchargeByCount: { 2: null, 3: null, 6: null },
    singlePaymentByType: { credit_card: null, debit_card: null, account_money: null },
    analyzedPayments: 0,
  }
}

function roundTo(value: number, decimals: number) {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function isFinancingCharge(name: string | null | undefined) {
  return typeof name === "string" && /financ/i.test(name)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Tasa con IVA de los cargos que cumplen `matches`: la exacta de
 * `charges_details` si Mercado Pago la informó; si no, monto / importe del
 * pago (fee_details, redondeado a centavos por Mercado Pago).
 */
function getChargePercent(
  snapshot: NonNullable<MercadoPagoObservationSourceRow["mercadopago_payment_snapshot"]>,
  matches: (name: string | null | undefined) => boolean,
): number | null {
  const rates = (snapshot.charges_details ?? [])
    .filter((charge) => matches(charge?.name) && Number.isFinite(Number(charge?.rate)))
    .map((charge) => Number(charge.rate))
  if (rates.length) return rates.reduce((total, rate) => total + rate, 0)

  const amount = Number(snapshot.transaction_amount)
  const fee = (snapshot.fee_details ?? [])
    .filter((detail) => matches(detail?.type))
    .reduce((total, detail) => total + Math.abs(Number(detail?.amount ?? 0)), 0)
  return fee > 0 && amount > 0 ? (fee / amount) * 100 : null
}

function toObservation(
  row: MercadoPagoObservationSourceRow,
  percentWithIva: number | null,
): MercadoPagoCostObservation | null {
  if (percentWithIva == null || !Number.isFinite(percentWithIva) || percentWithIva <= 0 || percentWithIva > MAX_PLAUSIBLE_PERCENT) {
    return null
  }
  const snapshot = row.mercadopago_payment_snapshot
  const paidAt = Date.parse(row.paid_at as string)
  const releaseAt = snapshot?.money_release_date ? Date.parse(snapshot.money_release_date) : Number.NaN
  return {
    percentWithIva: roundTo(percentWithIva, 3),
    observedAt: row.paid_at as string,
    paymentTypeId: snapshot?.payment_type_id ?? null,
    paymentMethodId: snapshot?.payment_method_id ?? null,
    installments: Number(snapshot?.installments ?? 1),
    releaseDays: Number.isFinite(releaseAt) && releaseAt >= paidAt ? Math.round((releaseAt - paidAt) / DAY_MS) : null,
    orderId: row.id,
  }
}

const OBSERVED_SINGLE_PAYMENT_TYPES: ObservedSinglePaymentType[] = ["credit_card", "debit_card", "account_money"]

/**
 * Observación segmentada por medio y cuotas (nunca se mezclan): dinero en
 * cuenta ≠ débito ≠ crédito 1 pago ≠ crédito 3 cuotas ≠ crédito 6 cuotas.
 *
 * - Comisión base: SÓLO crédito en 1 pago (`mercadopago_fee`); dinero en
 *   cuenta y débito se registran aparte, como referencia, y no la alimentan.
 * - Costo por N cuotas: SÓLO crédito en N cuotas con un cargo de
 *   financiación (cuotas sin interés absorbidas por BEYONIX). Un pago en
 *   cuotas SIN ese cargo lo financió el comprador y no dice nada del costo.
 * - Siempre la observación más reciente de cada combinación.
 */
export function deriveMercadoPagoObservedCosts(
  rows: MercadoPagoObservationSourceRow[],
  now: Date = new Date(),
): MercadoPagoObservedCosts {
  const minTime = now.getTime() - MERCADOPAGO_OBSERVATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  const eligible = rows
    .filter((row) => {
      const snapshot = row.mercadopago_payment_snapshot
      const paidAt = row.paid_at ? Date.parse(row.paid_at) : Number.NaN
      return (
        snapshot &&
        Array.isArray(snapshot.fee_details) &&
        Number(snapshot.transaction_amount) >= MERCADOPAGO_OBSERVATION_MIN_AMOUNT &&
        Number.isFinite(paidAt) &&
        paidAt >= minTime &&
        paidAt <= now.getTime()
      )
    })
    .sort((a, b) => Date.parse(b.paid_at as string) - Date.parse(a.paid_at as string))

  const result = getEmptyMercadoPagoObservedCosts()
  result.analyzedPayments = eligible.length

  for (const row of eligible) {
    const snapshot = row.mercadopago_payment_snapshot!
    const installments = Number(snapshot.installments ?? 1)
    const paymentType = snapshot.payment_type_id

    if (installments <= 1) {
      const type = OBSERVED_SINGLE_PAYMENT_TYPES.find((candidate) => candidate === paymentType)
      if (!type || result.singlePaymentByType[type]) continue
      const observation = toObservation(row, getChargePercent(snapshot, (name) => name === "mercadopago_fee"))
      if (observation) result.singlePaymentByType[type] = observation
      continue
    }

    // Cuotas: sólo crédito, y sólo con cargo de financiación a cargo de BEYONIX.
    const count = installments as InstallmentCount
    if (paymentType !== "credit_card" || !INSTALLMENT_COUNTS.includes(count) || result.surchargeByCount[count]) {
      continue
    }
    const observation = toObservation(row, getChargePercent(snapshot, isFinancingCharge))
    if (observation) result.surchargeByCount[count] = observation
  }

  result.base = result.singlePaymentByType.credit_card
  return result
}

function withoutIva(percentWithIva: number, ivaPercent: number) {
  return roundTo(percentWithIva / (1 + ivaPercent / 100), 2)
}

/**
 * Configuración EFECTIVA de costos. En manual, siempre los valores cargados.
 * En automático, cada costo usa su observación real si existe y, si no,
 * el valor manual como respaldo. El IVA siempre es el configurado: Mercado
 * Pago no lo informa por separado.
 */
export function resolveInstallmentsFinancing(
  manual: InstallmentsFinancingConfig,
  mode: MercadoPagoCostsMode,
  observed: MercadoPagoObservedCosts | null,
): ResolvedInstallmentsFinancing {
  const useObserved = mode === "automatic" && observed !== null
  const base = useObserved ? observed.base : null
  const surchargeByCount = {} as Record<InstallmentCount, number>
  const surchargeSources = {} as Record<InstallmentCount, MercadoPagoCostSource>

  for (const count of INSTALLMENT_COUNTS) {
    const observation = useObserved ? observed.surchargeByCount[count] : null
    surchargeByCount[count] = observation
      ? withoutIva(observation.percentWithIva, manual.ivaPercent)
      : manual.surchargePercentByCount[count]
    surchargeSources[count] = observation ? "observed" : "manual"
  }

  return {
    effective: {
      baseProcessingPercent: base
        ? withoutIva(base.percentWithIva, manual.ivaPercent)
        : manual.baseProcessingPercent,
      ivaPercent: manual.ivaPercent,
      surchargePercentByCount: surchargeByCount,
    },
    sources: { base: base ? "observed" : "manual", surchargeByCount: surchargeSources },
  }
}
