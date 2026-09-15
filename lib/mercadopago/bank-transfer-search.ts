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
/** Timeout de UNA sola request a Mercado Pago. */
const PAGE_FETCH_TIMEOUT_MS = 8_000
/**
 * Presupuesto de tiempo de pared para TODA la búsqueda (todas las páginas de
 * un mismo intento de verificación), no sólo por request individual. Antes
 * sólo existía el timeout por página (10s) sin ningún límite sobre la suma:
 * con MAX_PAGES=40 esto permitía que una sola orden tardara hasta 400s
 * (40 x 10s) en el peor caso, muy por encima del presupuesto del cron
 * (MAX_RETRY_RUN_DURATION_MS, ver transfer-verification-retry.ts), del lease
 * de "checking" (claim_transfer_verification_attempt) y del --max-time del
 * curl del systemd timer -- abriendo la puerta a que un intento viejo siga
 * vivo después de perder su lease. Cortar acá por tiempo se trata exactamente
 * igual que cortar por MAX_PAGES: nunca demuestra cobertura completa, así que
 * exhaustive queda en false.
 *
 * Este presupuesto es sobre el TOTAL de la búsqueda, no sólo "no arrancar
 * una página más": el timeout de cada request individual también se recorta
 * a lo que quede de presupuesto (nunca PAGE_FETCH_TIMEOUT_MS completos si
 * queda menos que eso) -- si no, una sola request lenta podía por sí sola
 * hacer que la búsqueda entera superara este presupuesto.
 */
const SEARCH_TIME_BUDGET_MS = 20_000

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
   * true SOLO si hay evidencia POSITIVA de cobertura completa. Estrategia
   * deliberadamente conservadora (tercera y cuarta auditoría): ante
   * cualquier duda, exhaustive=false y el llamador trata el resultado como
   * manual_review.
   *
   * La cobertura se mide SIEMPRE en payment.id ÚNICOS (Set, deduplicado
   * sobre TODOS los resultados recibidos, antes de filtrar por
   * status/tipo soportado) -- nunca en cantidad bruta de resultados. Una
   * cuenta bruta puede superar expectedTotal artificialmente si Mercado
   * Pago repite el mismo payment.id entre páginas (overlap de paginación)
   * sin que eso sea cobertura real.
   *
   * Dos formas válidas de demostrar cobertura:
   *  a) paging.total viene presente en TODAS las páginas relevantes, es
   *     siempre el mismo entero >= 0 (una vez fijado, nunca cambia, y nunca
   *     contradice -- ni por debajo ni por arriba -- la cantidad de
   *     payment.id únicos ya vistos en el momento de fijarse) y la cantidad
   *     de payment.id únicos lo alcanza.
   *  b) paging.total NUNCA viene presente en ninguna página (ni siquiera
   *     una vez) Y la última página devuelta vino más corta que el límite
   *     pedido -- única señal disponible cuando total jamás se usó.
   *
   * Cualquier inconsistencia inhabilita (a) para el resto de la búsqueda y
   * nunca cae de nuevo en (b): una página corta jamás alcanza por sí sola
   * si total indica que falta más (ej.: 1 resultado con total=100); un total
   * que ya queda por debajo de los payment.id únicos recibidos (incluso en
   * la misma página en la que aparece, o tarde, contradiciendo lo ya
   * observado) es inconsistencia; y una vez que se depende de total, que
   * una página posterior lo omita, lo cambie o lo mande inválido (ej.:
   * negativo) también lo es -- nunca "ausencia de evidencia = ok". false
   * también si la búsqueda se cortó por el tope de páginas (MAX_PAGES) o
   * por el presupuesto de tiempo (SEARCH_TIME_BUDGET_MS) sin poder
   * demostrar (a) ni (b): en ese caso el llamador NUNCA debe
   * auto-confirmar con lo que se llegó a traer.
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
  // Cuarta auditoría: contar payment.id ÚNICOS, nunca resultados brutos. Una
  // cantidad acumulada de resultados (sin dedupe) puede superar
  // artificialmente expectedTotal si Mercado Pago repite el mismo payment.id
  // entre páginas (overlap de paginación) sin que eso represente cobertura
  // real -- Codex reprodujo exactamente ese caso (100 resultados con sólo 50
  // payment.id distintos y total=100 marcaba exhaustive=true). El Set se
  // llena con TODOS los ids recibidos (antes de filtrar por status/tipo
  // soportado): total, cuando Mercado Pago lo informa, cuenta los resultados
  // crudos de la ventana, no sólo los que después pasan nuestro filtro local.
  const seenPaymentIds = new Set<string>()
  // Una vez que una página trae un total válido, se fija como referencia
  // para TODA la búsqueda (tercera auditoría: "una vez observado un total
  // válido, mantenerlo como expectedTotal"). A partir de ahí, total es la
  // ÚNICA fuente de verdad válida para esta búsqueda -- el tamaño de página
  // deja de usarse como señal.
  let expectedTotal: number | null = null
  // Una vez detectada cualquier inconsistencia (total ausente después de
  // haber visto uno válido, total inválido, total que contradice al ya
  // fijado, total que contradice lo ya recibido en el momento de fijarse, o
  // más payment.id únicos que expectedTotal), esta búsqueda entera nunca
  // puede llegar a exhaustive=true -- el flag es permanente para el resto
  // del loop.
  let totalIsInconsistent = false
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS

  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Presupuesto de tiempo total de la búsqueda agotado: cortamos ACÁ,
    // antes de arrancar otra request -- nunca podemos demostrar cobertura
    // completa en este caso (mismo criterio que el tope de páginas).
    const remainingBudgetMs = deadline - Date.now()
    if (remainingBudgetMs <= 0) {
      break
    }

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

    // El timeout de ESTA request nunca puede exceder el presupuesto que
    // queda de la búsqueda entera -- si sólo quedan, por ejemplo, 2s de
    // budget, la request tiene que abortar a los 2s como mucho, no a los
    // PAGE_FETCH_TIMEOUT_MS completos (eso permitía que una sola búsqueda
    // superara su propio presupuesto total, ver comentario de
    // SEARCH_TIME_BUDGET_MS).
    const requestTimeoutMs = Math.min(PAGE_FETCH_TIMEOUT_MS, remainingBudgetMs)

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/search?${params.toString()}`,
      {
        headers: mercadoPagoHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
    )

    if (!response.ok) {
      throw new Error(`Mercado Pago respondió ${response.status}`)
    }

    const payload = (await response.json()) as MercadoPagoSearchResponse
    const results = payload.results ?? []

    for (const raw of results) {
      seenPaymentIds.add(String(raw.id))
      const candidate = toCandidate(raw)
      if (candidate) candidates.push(candidate)
    }
    const uniqueCount = seenPaymentIds.size

    const rawTotal = payload.paging?.total
    const totalFieldPresent = rawTotal !== undefined && rawTotal !== null
    // Total válido: entero >= 0. Cualquier otra cosa (negativo, decimal,
    // NaN, string, etc.) que igual venga presente en el campo es un total
    // MALFORMADO -- eso es distinto de que el campo directamente no venga,
    // y nunca se trata como "sin evidencia" (sería tratarlo como si nunca
    // hubiera existido, ignorando que Mercado Pago mandó algo inconsistente).
    const isValidTotal =
      totalFieldPresent &&
      typeof rawTotal === "number" &&
      Number.isInteger(rawTotal) &&
      rawTotal >= 0

    if (totalFieldPresent && isValidTotal) {
      if (expectedTotal === null) {
        // Total recién aparece (puede ser la primera página, o una tardía
        // si las anteriores no lo informaban). Si ya contradice la cantidad
        // de payment.id únicos que veníamos observando hasta acá (ej.: total
        // llega tarde diciendo "2" cuando ya vimos 3 distintos, o "0" en la
        // misma página en la que llegó un resultado real) es inconsistencia
        // desde el primer momento -- nunca se fija como referencia.
        if (rawTotal < uniqueCount) {
          totalIsInconsistent = true
        } else {
          expectedTotal = rawTotal
        }
      } else if (rawTotal !== expectedTotal) {
        // Total cambió de forma incompatible respecto del ya fijado.
        totalIsInconsistent = true
      }
    } else if (totalFieldPresent) {
      // Total presente pero malformado (ej.: -1) -- inconsistencia dura,
      // haya o no expectedTotal todavía.
      totalIsInconsistent = true
    } else if (expectedTotal !== null) {
      // Ya habíamos fijado un total de referencia y esta página lo omite --
      // no se puede asumir que eso es inofensivo.
      totalIsInconsistent = true
    }

    // Chequeo de coherencia independiente de cuándo se fijó expectedTotal:
    // si en CUALQUIER momento la cantidad de payment.id únicos ya supera el
    // total de referencia, es una contradicción dura (nunca puede haber más
    // resultados únicos reales que los que Mercado Pago dice que existen).
    if (expectedTotal !== null && uniqueCount > expectedTotal) {
      totalIsInconsistent = true
    }

    if (totalIsInconsistent) {
      // Nunca se puede confiar en total para el resto de esta búsqueda, y
      // una vez que dependimos de total, el tamaño de página ya no es una
      // señal válida por sí sola. Seguimos paginando (dentro del tope de
      // páginas/presupuesto) por si acaso, pero esta búsqueda ya no puede
      // terminar en exhaustive=true.
      continue
    }

    if (expectedTotal !== null) {
      if (uniqueCount >= expectedTotal) {
        exhaustive = true
        break
      }
      continue
    }

    // Nunca vimos un total utilizable en ninguna página hasta acá: única
    // señal disponible es el tamaño de la página. Una página más corta que
    // el límite pedido significa que no hay más resultados después de
    // ésta -- exhaustivo.
    if (results.length < SEARCH_PAGE_LIMIT) {
      exhaustive = true
      break
    }
  }

  return { candidates, exhaustive }
}
