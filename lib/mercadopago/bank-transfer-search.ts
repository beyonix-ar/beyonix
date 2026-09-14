import "server-only"

import { mercadoPagoHeaders } from "./customer-credit-topups.ts"

/**
 * Únicamente los dos tipos de transferencia entrante comprobados contra la
 * cuenta real de Mercado Pago en la auditoría de FASE 1 (ver
 * mp_readonly_probe, ya eliminado):
 *
 * - account_fund + cvu: transferencia bancaria externa recibida por CVU/alias.
 * - money_transfer + account_money: transferencia recibida desde el saldo en
 *   cuenta de otro usuario de Mercado Pago, dirigida por alias/CVU.
 *
 * Ningún otro operation_type/payment_method_id se admite automáticamente:
 * no fueron observados ni testeados contra datos reales.
 */
export const SUPPORTED_BANK_TRANSFER_KINDS = [
  { operationType: "account_fund", paymentMethodId: "cvu" },
  { operationType: "money_transfer", paymentMethodId: "account_money" },
] as const

export function isSupportedBankTransferKind(
  operationType: string | null | undefined,
  paymentMethodId: string | null | undefined,
): boolean {
  return SUPPORTED_BANK_TRANSFER_KINDS.some(
    (kind) =>
      kind.operationType === operationType &&
      kind.paymentMethodId === paymentMethodId,
  )
}

export interface MercadoPagoBankTransferCandidate {
  /** payment.id de Mercado Pago -- identificador único usado para conciliación. */
  id: string
  status: string
  operationType: string
  paymentMethodId: string
  transactionAmount: number
  currencyId: string | null
  dateCreated: string | null
  dateApproved: string | null
  identificationType: string | null
  identificationNumber: string | null
  /**
   * transaction_details.bank_transfer_id -- comprobado que puede venir null
   * (transferencias money_transfer/account_money). Nunca se usa como
   * identificador único, sólo como metadata adicional cuando existe.
   */
  bankTransferId: string | null
}

interface RawMercadoPagoPayer {
  identification?: {
    type?: string | null
    number?: string | null
  } | null
}

interface RawMercadoPagoTransactionDetails {
  bank_transfer_id?: number | string | null
}

interface RawMercadoPagoSearchPayment {
  id: number | string
  status?: string | null
  operation_type?: string | null
  payment_method_id?: string | null
  transaction_amount?: number | null
  currency_id?: string | null
  date_created?: string | null
  date_approved?: string | null
  payer?: RawMercadoPagoPayer | null
  transaction_details?: RawMercadoPagoTransactionDetails | null
}

interface MercadoPagoSearchResponse {
  results?: RawMercadoPagoSearchPayment[]
  paging?: { total?: number; offset?: number; limit?: number }
}

const SEARCH_PAGE_LIMIT = 50
/**
 * Tope defensivo de PÁGINAS, no "la cantidad correcta de movimientos": sólo
 * protege contra un loop indefinido si Mercado Pago devolviera siempre
 * páginas llenas. 2000 movimientos (40 x 50) es un margen amplio sobre lo
 * esperable para la ventana de conciliación real (TRANSFER_MATCH_LOOKBACK_MINUTES
 * + TRANSFER_PAYMENT_EXPIRATION_HOURS, ver transfer-auto-verification.ts).
 * Una auto-confirmación NUNCA debe asumir que este tope alcanzó a cubrir
 * todo: ver el campo `exhaustive` del resultado -- si se corta acá sin haber
 * agotado las páginas (última página todavía llena), exhaustive queda en
 * false y el caller tiene que tratarlo como revisión manual, nunca como
 * "no hay más candidatos".
 */
const MAX_PAGES = 40
/** Tope defensivo sobre la ventana de fechas en sí -- nunca buscar "todo el historial". */
const MAX_SEARCH_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

function toCandidate(
  raw: RawMercadoPagoSearchPayment,
): MercadoPagoBankTransferCandidate | null {
  if (raw.status !== "approved") return null
  if (!isSupportedBankTransferKind(raw.operation_type, raw.payment_method_id)) {
    return null
  }

  const transactionAmount = Number(raw.transaction_amount)
  if (!Number.isFinite(transactionAmount) || transactionAmount <= 0) return null

  return {
    id: String(raw.id),
    status: raw.status,
    operationType: raw.operation_type ?? "",
    paymentMethodId: raw.payment_method_id ?? "",
    transactionAmount,
    currencyId: raw.currency_id ?? null,
    dateCreated: raw.date_created ?? null,
    dateApproved: raw.date_approved ?? null,
    identificationType: raw.payer?.identification?.type ?? null,
    identificationNumber: raw.payer?.identification?.number ?? null,
    bankTransferId:
      raw.transaction_details?.bank_transfer_id !== null &&
      raw.transaction_details?.bank_transfer_id !== undefined
        ? String(raw.transaction_details.bank_transfer_id)
        : null,
  }
}

export interface BankTransferSearchResult {
  candidates: MercadoPagoBankTransferCandidate[]
  /**
   * true SOLO si se puede demostrar que se recorrió todo el conjunto de
   * movimientos de la ventana (la API dejó de devolver una página llena, o
   * paging.total confirma que no queda nada más por traer). false si la
   * búsqueda se cortó por el tope defensivo de páginas (MAX_PAGES) sin poder
   * probar que no quedaba ningún otro candidato -- en ese caso el llamador
   * NUNCA debe auto-confirmar con lo que se llegó a traer: el conjunto
   * relevante no fue evaluado completamente.
   */
  exhaustive: boolean
}

/**
 * Busca transferencias entrantes aprobadas dentro de una ventana de fechas
 * acotada, paginando todo lo necesario dentro de esa ventana (hasta
 * MAX_PAGES como tope defensivo -- ver comentario de la constante). Nunca
 * devuelve movimientos fuera de los tipos soportados
 * (SUPPORTED_BANK_TRANSFER_KINDS) ni con status distinto de "approved".
 *
 * Filtra en backend (nunca expone la lista completa de movimientos al
 * navegador -- eso es responsabilidad exclusiva del llamador server-side).
 */
export async function searchIncomingBankTransfers({
  beginDate,
  endDate,
}: {
  beginDate: Date
  endDate: Date
}): Promise<BankTransferSearchResult> {
  if (endDate.getTime() <= beginDate.getTime()) {
    throw new Error("Ventana de búsqueda inválida: la fecha de fin debe ser posterior al inicio.")
  }
  if (endDate.getTime() - beginDate.getTime() > MAX_SEARCH_WINDOW_MS) {
    throw new Error("Ventana de búsqueda demasiado amplia para conciliación de transferencias.")
  }

  const candidates: MercadoPagoBankTransferCandidate[] = []
  let exhaustive = false

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const offset = page * SEARCH_PAGE_LIMIT
    const params = new URLSearchParams({
      sort: "date_created",
      criteria: "desc",
      limit: String(SEARCH_PAGE_LIMIT),
      offset: String(offset),
      range: "date_created",
      begin_date: beginDate.toISOString(),
      end_date: endDate.toISOString(),
    })

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/search?${params.toString()}`,
      {
        headers: mercadoPagoHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      },
    )

    if (!response.ok) {
      throw new Error(`Mercado Pago respondió ${response.status}`)
    }

    const payload = (await response.json()) as MercadoPagoSearchResponse
    const results = payload.results ?? []

    for (const raw of results) {
      const candidate = toCandidate(raw)
      if (candidate) candidates.push(candidate)
    }

    // Página parcial: no hay más resultados después de ésta -- exhaustivo.
    if (results.length < SEARCH_PAGE_LIMIT) {
      exhaustive = true
      break
    }

    // Página llena, pero paging.total (cuando la API lo informa) confirma
    // que ya cubrimos todo lo que hay -- no confiamos ciegamente en esto
    // como ÚNICA señal (por eso sigue siendo opcional), pero cuando está
    // presente evita una página final vacía innecesaria.
    const total = payload.paging?.total
    if (typeof total === "number" && offset + results.length >= total) {
      exhaustive = true
      break
    }
  }

  return { candidates, exhaustive }
}
