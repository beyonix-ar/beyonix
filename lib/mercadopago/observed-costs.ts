import {
  INSTALLMENT_COUNTS,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "../products/installments.ts"

/**
 * Costos de Mercado Pago "observados": se derivan de los pagos aprobados que
 * el webhook ya persiste en `ordenes.mercadopago_payment_snapshot`
 * (charges_details / fee_details / transaction_amount, dato REAL cobrado por
 * Mercado Pago). Mercado Pago no expone por API la comisión configurada en la
 * cuenta antes de vender, así que la única fuente automática honesta es lo
 * que efectivamente cobró en los pagos reales.
 *
 * Aprendizaje: cada modalidad (crédito 1 pago, crédito 2/3/6 cuotas, débito,
 * dinero en cuenta) aprende SU propio costo, nunca de otra. El último pago
 * aprobado y confiable de esa modalidad es el costo vigente hasta que otro
 * pago muestre un valor distinto: UN solo pago aprobado y confiable alcanza
 * para aprender, aunque el cambio sea grande. Los datos no confiables
 * (modalidad o cuotas inconsistentes, cargo inexistente, porcentaje no
 * finito, <= 0 o fuera del rango técnicamente posible) nunca reemplazan el
 * costo vigente.
 *
 * El historial se deriva de los mismos pagos (inmutables): nada se reescribe
 * y cada venta conserva su propio snapshot de precio.
 *
 * Las tasas observadas incluyen IVA (Mercado Pago no lo discrimina en el
 * pago): se convierten a "sin IVA" con el IVA configurado para mantener el
 * mismo modelo de `InstallmentsFinancingConfig`.
 */

export type MercadoPagoCostsMode = "automatic" | "manual"

export const DEFAULT_MERCADOPAGO_COSTS_MODE: MercadoPagoCostsMode = "manual"

/** Monto mínimo del pago: por debajo, el redondeo a centavos distorsiona la tasa. */
export const MERCADOPAGO_OBSERVATION_MIN_AMOUNT = 100
/** Pagos recientes que se leen POR MODALIDAD (cada una conserva su último costo aunque se venda poco). */
export const MERCADOPAGO_OBSERVATION_SAMPLE_SIZE = 20
/** Cambios menores a esto (puntos) son redondeo: no cuentan como cambio de costo. */
const CHANGE_EPSILON_POINTS = 0.01
const HISTORY_LIMIT = 20

export type MercadoPagoCostModality =
  | "credit_1"
  | "credit_2"
  | "credit_3"
  | "credit_6"
  | "debit_1"
  | "account_money_1"

/** Qué se lee de cada modalidad: medio de pago + cuotas (también lo usa la consulta a la base). */
export const MERCADOPAGO_COST_MODALITIES: ReadonlyArray<{
  modality: MercadoPagoCostModality
  paymentTypeId: ObservedSinglePaymentType
  installments: 1 | InstallmentCount
}> = [
  { modality: "credit_1", paymentTypeId: "credit_card", installments: 1 },
  { modality: "credit_2", paymentTypeId: "credit_card", installments: 2 },
  { modality: "credit_3", paymentTypeId: "credit_card", installments: 3 },
  { modality: "credit_6", paymentTypeId: "credit_card", installments: 6 },
  { modality: "debit_1", paymentTypeId: "debit_card", installments: 1 },
  { modality: "account_money_1", paymentTypeId: "account_money", installments: 1 },
]

/** Tope razonable (con IVA) por tipo de costo: por encima el dato no es confiable. */
const MAX_PLAUSIBLE_PERCENT = { single: 15, financing: 45 } as const

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
    checkout_modality?: string | null
    transaction_details?: { total_paid_amount?: number | null } | null
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

/** Cambio de costo detectado en un pago real: se aplica desde la próxima venta. */
export interface MercadoPagoCostChangeEvent {
  modality: MercadoPagoCostModality
  /** `null` = primer costo observado de esta modalidad. */
  previousPercentWithIva: number | null
  percentWithIva: number
  observedAt: string
  orderId: number
}

export interface MercadoPagoObservedCosts {
  /** Comisión base: SÓLO tarjeta de crédito en 1 pago (con lo que se cobra el precio financiado). */
  base: MercadoPagoCostObservation | null
  /** Costo de N cuotas: SÓLO crédito en N cuotas con cargo de financiación. */
  surchargeByCount: Record<InstallmentCount, MercadoPagoCostObservation | null>
  /** Referencia por medio en 1 pago (informativa: no alimenta ningún cálculo salvo crédito → base). */
  singlePaymentByType: Record<ObservedSinglePaymentType, MercadoPagoCostObservation | null>
  /** Pagos aprobados con costo informado que se analizaron. */
  analyzedPayments: number
  /** Cambios detectados, del más nuevo al más viejo (compacto). */
  history: MercadoPagoCostChangeEvent[]
  /** Último costo nuevo aplicado automáticamente. */
  lastAppliedAt: string | null
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
    history: [],
    lastAppliedAt: null,
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

type Snapshot = NonNullable<MercadoPagoObservationSourceRow["mercadopago_payment_snapshot"]>

/**
 * Tasa con IVA de los cargos que cumplen `matches`: la exacta de
 * `charges_details` si Mercado Pago la informó; si no, monto / importe del
 * pago (fee_details, redondeado a centavos por Mercado Pago).
 */
function getChargePercent(
  snapshot: Snapshot,
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

/** Centavos de tolerancia para comparar lo pagado por el comprador con el importe del pago. */
const BUYER_INTEREST_TOLERANCE = 0.01

/**
 * El comprador pagó más que el importe del pago: Mercado Pago le cobró
 * interés (cuotas CON interés). Ese pago no dice nada del costo que absorbe
 * BEYONIX.
 */
function buyerPaidInterest(snapshot: Snapshot) {
  const paid = Number(snapshot.transaction_details?.total_paid_amount)
  const amount = Number(snapshot.transaction_amount)
  return Number.isFinite(paid) && Number.isFinite(amount) && paid - amount > BUYER_INTEREST_TOLERANCE
}

/**
 * Modalidad de un pago aprobado (nunca se mezclan): 1 pago por medio; cuotas
 * SÓLO crédito en 2/3/6 con cargo de financiación (cuotas sin interés que
 * absorbió BEYONIX). Un pago en cuotas sin ese cargo, o en el que el
 * comprador pagó interés, lo financió el comprador, y uno en cuotas de una
 * compra "1 pago" no es posible (la preferencia se crea con 1 cuota):
 * ninguno dice nada del costo. Un pago en 1 pago dentro de una compra "en
 * cuotas" (dinero en cuenta, o el cliente eligió 1 cuota) sí informa el
 * costo real de SU modalidad.
 */
function getModality(snapshot: Snapshot): MercadoPagoCostModality | null {
  const installments = Number(snapshot.installments ?? 1)
  const paymentType = snapshot.payment_type_id
  if (!Number.isInteger(installments) || buyerPaidInterest(snapshot)) return null
  if (installments <= 1) {
    if (paymentType === "credit_card") return "credit_1"
    if (paymentType === "debit_card") return "debit_1"
    if (paymentType === "account_money") return "account_money_1"
    return null
  }
  if (paymentType !== "credit_card" || !INSTALLMENT_COUNTS.includes(installments as InstallmentCount)) return null
  if (snapshot.checkout_modality === "mercadopago_cash") return null
  return `credit_${installments}` as MercadoPagoCostModality
}

function toObservation(
  row: MercadoPagoObservationSourceRow,
  modality: MercadoPagoCostModality,
): MercadoPagoCostObservation | null {
  const snapshot = row.mercadopago_payment_snapshot as Snapshot
  const financing = modality === "credit_2" || modality === "credit_3" || modality === "credit_6"
  const percentWithIva = getChargePercent(
    snapshot,
    financing ? isFinancingCharge : (name) => name === "mercadopago_fee",
  )
  const max = financing ? MAX_PLAUSIBLE_PERCENT.financing : MAX_PLAUSIBLE_PERCENT.single
  if (percentWithIva == null || !Number.isFinite(percentWithIva) || percentWithIva <= 0 || percentWithIva > max) {
    return null
  }
  const paidAt = Date.parse(row.paid_at as string)
  const releaseAt = snapshot.money_release_date ? Date.parse(snapshot.money_release_date) : Number.NaN
  return {
    percentWithIva: roundTo(percentWithIva, 3),
    observedAt: row.paid_at as string,
    paymentTypeId: snapshot.payment_type_id ?? null,
    paymentMethodId: snapshot.payment_method_id ?? null,
    installments: Number(snapshot.installments ?? 1),
    releaseDays: Number.isFinite(releaseAt) && releaseAt >= paidAt ? Math.round((releaseAt - paidAt) / DAY_MS) : null,
    orderId: row.id,
  }
}

/**
 * Costo vigente por modalidad y cambios detectados, recorriendo los pagos
 * del más viejo al más nuevo:
 * - el primer pago confiable define el costo;
 * - cada pago nuevo confiable lo reemplaza de inmediato, sin importar el
 *   tamaño del cambio (si cambió, queda en el historial como aplicado para
 *   las próximas ventas);
 * - un pago no confiable se ignora y sigue el costo anterior.
 */
export function deriveMercadoPagoObservedCosts(
  rows: MercadoPagoObservationSourceRow[],
  now: Date = new Date(),
): MercadoPagoObservedCosts {
  const seen = new Set<number>()
  const eligible = rows
    .filter((row) => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      const snapshot = row.mercadopago_payment_snapshot
      const paidAt = row.paid_at ? Date.parse(row.paid_at) : Number.NaN
      return (
        snapshot &&
        Array.isArray(snapshot.fee_details) &&
        Number(snapshot.transaction_amount) >= MERCADOPAGO_OBSERVATION_MIN_AMOUNT &&
        Number.isFinite(paidAt) &&
        paidAt <= now.getTime()
      )
    })
    .sort((a, b) => Date.parse(a.paid_at as string) - Date.parse(b.paid_at as string) || a.id - b.id)

  const current = new Map<MercadoPagoCostModality, MercadoPagoCostObservation>()
  const history: MercadoPagoCostChangeEvent[] = []
  const event = (
    modality: MercadoPagoCostModality,
    previous: MercadoPagoCostObservation | undefined,
    observation: MercadoPagoCostObservation,
  ) =>
    history.push({
      modality,
      previousPercentWithIva: previous?.percentWithIva ?? null,
      percentWithIva: observation.percentWithIva,
      observedAt: observation.observedAt,
      orderId: observation.orderId,
    })

  for (const row of eligible) {
    const modality = getModality(row.mercadopago_payment_snapshot as Snapshot)
    if (!modality) continue
    const observation = toObservation(row, modality)
    if (!observation) continue

    const previous = current.get(modality)
    if (!previous || Math.abs(observation.percentWithIva - previous.percentWithIva) >= CHANGE_EPSILON_POINTS) {
      event(modality, previous, observation)
    }
    current.set(modality, observation)
  }

  const result = getEmptyMercadoPagoObservedCosts()
  result.analyzedPayments = eligible.length
  result.singlePaymentByType = {
    credit_card: current.get("credit_1") ?? null,
    debit_card: current.get("debit_1") ?? null,
    account_money: current.get("account_money_1") ?? null,
  }
  result.base = result.singlePaymentByType.credit_card
  for (const count of INSTALLMENT_COUNTS) {
    result.surchargeByCount[count] = current.get(`credit_${count}`) ?? null
  }
  result.history = history.reverse().slice(0, HISTORY_LIMIT)
  result.lastAppliedAt = result.history[0]?.observedAt ?? null
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
