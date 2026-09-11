import "server-only"

/**
 * Llamadas HTTP crudas al refund de Mercado Pago. Server-only a propósito:
 * MERCADOPAGO_ACCESS_TOKEN nunca debe llegar al cliente ni loguearse. Este
 * módulo NO decide si corresponde reembolsar ni cuánto -- eso vive en
 * lib/mercadopago/order-refund.ts, que valida todo server-side antes de
 * llamar a estas funciones. Acá sólo hay transporte HTTP + clasificación de
 * la respuesta.
 */

export interface MercadoPagoRefund {
  id: number
  payment_id: number
  amount: number
  status?: string | null
  date_created?: string | null
}

export type MercadoPagoRefundOutcome =
  | { kind: "confirmed"; refund: MercadoPagoRefund }
  /** Mercado Pago respondió con un rechazo de negocio explícito (4xx con cuerpo JSON parseable) -- definitivo, seguro de registrar como fallido. */
  | { kind: "rejected"; status: number; code: string | null; message: string }
  /** Fetch/timeout/5xx/respuesta no-JSON: el estado real es DESCONOCIDO. Nunca tratar como fallo definitivo ni reintentar el POST a ciegas. */
  | { kind: "unknown"; reason: string }

function getAccessToken() {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  if (!accessToken) throw new Error("MERCADOPAGO_ACCESS_TOKEN no configurado")
  return accessToken
}

/** Nunca incluir el resultado de esta función en un log ni en un mensaje de error. */
function mercadoPagoRefundHeaders(idempotencyKey: string) {
  return {
    Authorization: `Bearer ${getAccessToken()}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Idempotency-Key": idempotencyKey,
  }
}

/**
 * Quita cualquier posible rastro del access token de un texto antes de
 * loguearlo o devolverlo en un mensaje de error. Nunca debería aparecer (el
 * token sólo se usa dentro del header Authorization, jamás en un body/mensaje
 * armado por este módulo), pero es una segunda barrera barata.
 */
function sanitizeRefundMessage(value: string) {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim()
  if (!accessToken) return value
  return value.split(accessToken).join("[REDACTED]")
}

function isValidPaymentId(paymentId: string) {
  return /^\d+$/.test(paymentId.trim())
}

/**
 * POST /v1/payments/{payment_id}/refunds -- refund total del pago (sin
 * `amount` en el body, Mercado Pago reembolsa el importe capturado completo
 * de ESE payment_id). `idempotencyKey` debe ser estable entre reintentos de
 * la MISMA operación (la genera y persiste la RPC de negocio, nunca esta
 * función) -- un valor nuevo en cada retry duplicaría el refund ante
 * cualquier problema de red que sí haya llegado a procesarse en Mercado Pago.
 */
export async function createMercadoPagoRefund(
  paymentId: string,
  idempotencyKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MercadoPagoRefundOutcome> {
  if (!isValidPaymentId(paymentId)) {
    return { kind: "unknown", reason: "payment_id inválido" }
  }
  if (!idempotencyKey.trim()) {
    return { kind: "unknown", reason: "idempotencyKey vacía" }
  }

  let response: Response
  try {
    response = await fetchImpl(
      `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}/refunds`,
      {
        method: "POST",
        headers: mercadoPagoRefundHeaders(idempotencyKey),
        body: "{}",
        signal: AbortSignal.timeout(20_000),
      },
    )
  } catch (error) {
    // AbortSignal.timeout() dispara un DOMException "TimeoutError" -- pero
    // CUALQUIER excepción de red (DNS, conexión reseteada, etc.) es
    // exactamente igual de ambigua: no sabemos si Mercado Pago llegó a
    // procesar el refund. Nunca se trata como "no ocurrió".
    const isTimeout =
      (error instanceof DOMException && error.name === "TimeoutError") ||
      (error instanceof Error && error.name === "TimeoutError")
    return {
      kind: "unknown",
      reason: isTimeout
        ? "timeout esperando respuesta de Mercado Pago"
        : sanitizeRefundMessage(
            `error de red: ${error instanceof Error ? error.message : String(error)}`,
          ),
    }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    // Un 2xx sin JSON parseable es tan ambiguo como un timeout: no hay forma
    // de confirmar que sea un refund válido.
    return {
      kind: "unknown",
      reason: `status ${response.status} sin cuerpo JSON válido`,
    }
  }

  if (!response.ok) {
    // 5xx: el propio Mercado Pago no puede confirmar su propio resultado --
    // tratamos igual que timeout/desconocido, nunca como rechazo definitivo.
    if (response.status >= 500) {
      return {
        kind: "unknown",
        reason: `Mercado Pago respondió ${response.status} (error de servidor)`,
      }
    }

    const errorBody = payload as { message?: unknown; error?: unknown; cause?: unknown } | null
    const message =
      typeof errorBody?.message === "string"
        ? errorBody.message
        : typeof errorBody?.error === "string"
          ? errorBody.error
          : `Mercado Pago rechazó el refund (status ${response.status})`
    const code =
      Array.isArray(errorBody?.cause) && errorBody?.cause[0] && typeof errorBody.cause[0] === "object"
        ? String((errorBody.cause[0] as { code?: unknown }).code ?? "") || null
        : null

    return {
      kind: "rejected",
      status: response.status,
      code,
      message: sanitizeRefundMessage(message),
    }
  }

  const refund = payload as Partial<MercadoPagoRefund> | null
  if (
    !refund ||
    typeof refund.id !== "number" ||
    typeof refund.payment_id !== "number"
  ) {
    return {
      kind: "unknown",
      reason: "respuesta 2xx sin id de refund válido",
    }
  }

  return { kind: "confirmed", refund: refund as MercadoPagoRefund }
}

/**
 * GET /v1/payments/{payment_id}/refunds/{refund_id} -- para reconciliar un
 * intento en 'needs_reconciliation'/'processing' SIN volver a hacer POST.
 * Si `refundId` es null (nunca llegamos a recibir un id), consulta la lista
 * completa de refunds del payment para ver si Mercado Pago ya tiene alguno
 * registrado de todos modos (POST aceptado pero la respuesta nunca llegó).
 */
export async function getMercadoPagoRefundStatus(
  paymentId: string,
  refundId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { kind: "found"; refund: MercadoPagoRefund }
  | { kind: "not_found" }
  | { kind: "unknown"; reason: string }
> {
  if (!isValidPaymentId(paymentId)) {
    return { kind: "unknown", reason: "payment_id inválido" }
  }

  const url = refundId
    ? `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`
    : `https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}/refunds`

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${getAccessToken()}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return {
      kind: "unknown",
      reason: sanitizeRefundMessage(
        `error de red reconciliando: ${error instanceof Error ? error.message : String(error)}`,
      ),
    }
  }

  if (response.status === 404) return { kind: "not_found" }
  if (!response.ok) {
    return { kind: "unknown", reason: `Mercado Pago respondió ${response.status} al reconciliar` }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { kind: "unknown", reason: "respuesta de reconciliación sin JSON válido" }
  }

  const candidate = refundId ? payload : Array.isArray(payload) ? payload[0] : null
  const refund = candidate as Partial<MercadoPagoRefund> | null
  if (!refund || typeof refund.id !== "number" || typeof refund.payment_id !== "number") {
    return refundId
      ? { kind: "unknown", reason: "respuesta de reconciliación sin id de refund válido" }
      : { kind: "not_found" }
  }

  return { kind: "found", refund: refund as MercadoPagoRefund }
}
