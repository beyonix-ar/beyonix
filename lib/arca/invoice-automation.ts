/**
 * Facturación ARCA (Factura C) — servicio ÚNICO para el worker automático y
 * para el botón manual de Admin. Nunca se dispara desde la UI del cliente.
 *
 * Qué pedido se factura lo decide la base (order_is_invoiceable +
 * trigger zz_queue_arca_invoice, migración 20260927100000): pago confirmado
 * por BEYONIX, stock consumido, sin cancelación/reintegro/conflicto.
 *
 * Garantía central: una venta NUNCA se factura dos veces.
 *   1. claim_arca_invoice serializa (un solo 'processing' a la vez, con lease).
 *   2. Antes de pedir CAE se persiste el número y el ambiente ARCA
 *      (record_arca_invoice_request). Homologación y producción numeran por
 *      separado: nunca se concilia un número en otro ambiente (20260927120000).
 *   3. Si ese número ya estaba pedido (respuesta perdida, reinicio, fallo al
 *      guardar), primero se RECONCILIA contra ARCA y se adopta el comprobante
 *      existente; sólo se pide otro número si ARCA confirma que no lo autorizó.
 *   4. complete_arca_invoice es idempotente y jamás pisa otra factura.
 * Un fallo de ARCA nunca revierte pago, stock ni pedido: queda en 'error' con
 * reintento y el motivo visible para Admin.
 */

import type { ArcaEnvironment } from "./environment.ts"
import type { AuthorizedVoucher, FecaeRequest, FecaeResult } from "./wsfe.ts"

export const FACTURA_C_VOUCHER_TYPE = 11
const LEASE = "10 minutes"
const MAX_BACKOFF_MINUTES = 60

export interface ArcaInvoiceGateway {
  /**
   * Ambiente ARCA con el que habla este gateway. Es el que se persiste con
   * cada número pedido y el único en el que se concilia.
   */
  readonly environment: ArcaEnvironment
  lastAuthorized(pointOfSale: number, voucherType: number): Promise<number>
  consult(pointOfSale: number, voucherNumber: number, voucherType: number): Promise<AuthorizedVoucher | null>
  requestCae(request: FecaeRequest): Promise<FecaeResult>
  /** Rechazo definitivo de ARCA (el número NO quedó autorizado). */
  isDefinitiveRejection(error: unknown): boolean
  describeError(error: unknown): string
}

interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: { message: string } | null
  }>
}

export interface ClaimedInvoiceOrder {
  id: number
  total: number | string | null
  invoice_attempts: number | null
  invoice_requested_point: number | null
  invoice_requested_type: number | null
  invoice_requested_number: number | string | null
  invoice_requested_total: number | string | null
  invoice_requested_date: string | null
  invoice_arca_environment: string | null
}

export interface AuthorizedInvoice {
  orderId: number
  environment: ArcaEnvironment
  pointOfSale: number
  voucherType: number
  voucherNumber: number
  cae: string
  caeDue: string
  issueDate: string
  total: number
  reconciled: boolean
}

export type ArcaInvoiceResult =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "already_authorized" }
  | { status: "not_invoiceable" }
  | { status: "authorized"; invoice: AuthorizedInvoice }
  | { status: "failed"; orderId: number; error: string; willRetry: boolean }

export interface ProcessArcaInvoiceOptions {
  gateway: ArcaInvoiceGateway
  pointOfSale: number
  /** Pedido puntual (Admin). Sin él se toma el próximo de la cola. */
  orderId?: number | null
  manual?: boolean
  now?: () => Date
}

class ArcaInvoiceRpcError extends Error {}

export function getArcaPointOfSale(value = process.env.ARCA_PTO_VTA) {
  const pointOfSale = Number(value)
  if (!Number.isInteger(pointOfSale) || pointOfSale <= 0) {
    throw new Error("ARCA_PTO_VTA debe ser un entero mayor que cero.")
  }
  return pointOfSale
}

export function argentinaDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    arca: `${value.year}${value.month}${value.day}`,
    iso: `${value.year}-${value.month}-${value.day}`,
  }
}

function arcaDateToIso(value: string | null | undefined) {
  if (!value || !/^\d{8}$/.test(value)) {
    throw new Error("ARCA devolvió una fecha inválida.")
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function cents(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN
}

/** Reintento con backoff: 2, 4, 8… minutos, tope 60. */
export function invoiceRetryDelayMinutes(attempts: number) {
  return Math.min(MAX_BACKOFF_MINUTES, 2 ** Math.max(1, Math.min(attempts, 6)))
}

async function rpc<T>(admin: RpcClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args)
  if (error) throw new ArcaInvoiceRpcError(error.message)
  return data as T
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null
  return (data as T) ?? null
}

async function claim(admin: RpcClient, orderId: number | null, manual: boolean) {
  try {
    const data = await rpc<unknown>(admin, "claim_arca_invoice", {
      p_order_id: orderId,
      p_lease: LEASE,
      p_manual: manual,
    })
    return firstRow<ClaimedInvoiceOrder>(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/INVOICE_ALREADY_AUTHORIZED/.test(message)) return "already_authorized" as const
    if (/ORDER_NOT_INVOICEABLE/.test(message)) return "not_invoiceable" as const
    if (/INVOICE_(PROCESSING_IN_PROGRESS|ALREADY_PROCESSING)/.test(message)) return "busy" as const
    throw error
  }
}

async function fail(
  admin: RpcClient,
  order: ClaimedInvoiceOrder,
  error: string,
  { retry, releaseRequest }: { retry: boolean; releaseRequest: boolean },
): Promise<ArcaInvoiceResult> {
  const attempts = Number(order.invoice_attempts ?? 1)
  await rpc(admin, "fail_arca_invoice_attempt", {
    p_order_id: order.id,
    p_error: error,
    p_retry_after: retry ? `${invoiceRetryDelayMinutes(attempts)} minutes` : null,
    p_release_request: releaseRequest,
  })
  console.error("ARCA_INVOICE_ATTEMPT_FAILED", { orderId: order.id, attempts, error, releaseRequest })
  return { status: "failed", orderId: order.id, error, willRetry: retry }
}

async function complete(
  admin: RpcClient,
  order: ClaimedInvoiceOrder,
  invoice: Omit<AuthorizedInvoice, "orderId">,
): Promise<ArcaInvoiceResult> {
  await rpc(admin, "complete_arca_invoice", {
    p_order_id: order.id,
    p_point: invoice.pointOfSale,
    p_type: invoice.voucherType,
    p_number: invoice.voucherNumber,
    p_cae: invoice.cae,
    p_cae_due: invoice.caeDue,
    p_issued_at: `${invoice.issueDate}T12:00:00-03:00`,
    p_reconciled: invoice.reconciled,
    p_environment: invoice.environment,
  })
  return { status: "authorized", invoice: { orderId: order.id, ...invoice } }
}

/**
 * Hubo un pedido de CAE cuyo resultado no se conoce. Nunca se pide otro
 * número sin antes saber si ARCA autorizó éste.
 */
async function reconcile(
  admin: RpcClient,
  order: ClaimedInvoiceOrder,
  gateway: ArcaInvoiceGateway,
): Promise<ArcaInvoiceResult | "not_authorized"> {
  const point = Number(order.invoice_requested_point)
  const type = Number(order.invoice_requested_type ?? FACTURA_C_VOUCHER_TYPE)
  const number = Number(order.invoice_requested_number)
  // Un número pedido en otro ambiente no existe en éste: consultarlo acá
  // podría adoptar un comprobante ajeno o liberar uno autorizado.
  if (order.invoice_arca_environment !== gateway.environment) {
    return fail(
      admin,
      order,
      `El comprobante ${point}-${number} se pidió en ARCA ${order.invoice_arca_environment ?? "sin ambiente"} y la aplicación está en ${gateway.environment}. Revisión manual: no se concilia entre ambientes.`,
      { retry: false, releaseRequest: false },
    )
  }
  const last = await gateway.lastAuthorized(point, type)
  if (last < number) return "not_authorized"

  const voucher = await gateway.consult(point, number, type)
  if (
    voucher?.cae &&
    voucher.caeDueDate &&
    cents(voucher.total) === cents(order.invoice_requested_total) &&
    (!order.invoice_requested_date || voucher.voucherDate === order.invoice_requested_date)
  ) {
    return complete(admin, order, {
      environment: gateway.environment,
      pointOfSale: point,
      voucherType: type,
      voucherNumber: number,
      cae: voucher.cae,
      caeDue: arcaDateToIso(voucher.caeDueDate),
      issueDate: arcaDateToIso(voucher.voucherDate),
      total: cents(voucher.total) / 100,
      reconciled: true,
    })
  }

  // El número existe en ARCA pero no coincide con esta venta: nunca se
  // adopta ni se pide otro número. Requiere revisión humana.
  return fail(
    admin,
    order,
    `ARCA tiene autorizado el comprobante ${point}-${number} con otros datos. Revisión manual: no se reintenta automáticamente.`,
    { retry: false, releaseRequest: false },
  )
}

export async function processArcaInvoice(
  admin: RpcClient,
  options: ProcessArcaInvoiceOptions,
): Promise<ArcaInvoiceResult> {
  const { gateway, pointOfSale, manual = false } = options
  const now = options.now ?? (() => new Date())
  const claimed = await claim(admin, options.orderId ?? null, manual)
  if (claimed === null) return { status: options.orderId ? "busy" : "idle" }
  if (typeof claimed === "string") return { status: claimed }
  let order = claimed

  try {
    if (order.invoice_requested_number != null) {
      const reconciled = await reconcile(admin, order, gateway)
      if (reconciled !== "not_authorized") return reconciled
      // ARCA confirmó que ese número no se autorizó: se libera y se vuelve a
      // tomar el MISMO pedido (serializado) para pedir un número nuevo.
      await fail(admin, order, "El pedido de CAE anterior no fue autorizado por ARCA; se reintenta.", {
        retry: true,
        releaseRequest: true,
      })
      const again = await claim(admin, order.id, manual)
      if (again === null || typeof again === "string") {
        return typeof again === "string" ? { status: again } : { status: "busy" }
      }
      order = again
    }

    const total = cents(order.total) / 100
    if (!(total > 0)) {
      return fail(admin, order, "El pedido tiene un total inválido para facturar.", { retry: false, releaseRequest: false })
    }

    const last = await gateway.lastAuthorized(pointOfSale, FACTURA_C_VOUCHER_TYPE)
    const lastVoucher = await gateway.consult(pointOfSale, last, FACTURA_C_VOUCHER_TYPE)
    const issueDate = argentinaDate(now())
    if (lastVoucher && issueDate.arca < lastVoucher.voucherDate) {
      return fail(admin, order, "La fecha del comprobante no puede ser anterior a la última autorizada por ARCA.", {
        retry: true,
        releaseRequest: false,
      })
    }

    const voucherNumber = last + 1
    await rpc(admin, "record_arca_invoice_request", {
      p_order_id: order.id,
      p_point: pointOfSale,
      p_type: FACTURA_C_VOUCHER_TYPE,
      p_number: voucherNumber,
      p_total: total,
      p_date: issueDate.arca,
      p_environment: gateway.environment,
    })

    let authorization: FecaeResult
    try {
      authorization = await gateway.requestCae({
        pointOfSale,
        voucherType: FACTURA_C_VOUCHER_TYPE,
        voucherNumber,
        voucherDate: issueDate.arca,
        total,
      })
    } catch (error) {
      return fail(admin, order, gateway.describeError(error), {
        retry: true,
        // Sólo un rechazo explícito libera el número; si no se sabe, se
        // reconcilia en el próximo intento.
        releaseRequest: gateway.isDefinitiveRejection(error),
      })
    }

    if (authorization.voucherNumber !== voucherNumber) {
      return fail(
        admin,
        order,
        `ARCA autorizó el comprobante ${authorization.voucherNumber} en lugar del ${voucherNumber}. Revisión manual.`,
        { retry: false, releaseRequest: false },
      )
    }

    return await complete(admin, order, {
      environment: gateway.environment,
      pointOfSale,
      voucherType: FACTURA_C_VOUCHER_TYPE,
      voucherNumber,
      cae: authorization.cae,
      caeDue: arcaDateToIso(authorization.caeDueDate),
      issueDate: issueDate.iso,
      total,
      reconciled: false,
    })
  } catch (error) {
    // Error de red/ARCA/base fuera de la solicitud de CAE: si ya había un
    // número pedido se conserva para reconciliar.
    const message = gateway.describeError(error)
    try {
      return await fail(admin, order, message, { retry: true, releaseRequest: false })
    } catch (failError) {
      // Ni siquiera se pudo registrar: el lease vence y el próximo intento
      // reconcilia. Nunca se asume nada.
      console.error("ARCA_INVOICE_FAIL_RECORD_ERROR", { orderId: order.id, message, failError })
      return { status: "failed", orderId: order.id, error: message, willRetry: true }
    }
  }
}

/** Worker: procesa la cola de a un pedido (la numeración ARCA es secuencial). */
export async function processArcaInvoiceQueue(
  admin: RpcClient,
  options: Omit<ProcessArcaInvoiceOptions, "orderId" | "manual"> & { limit?: number; deadlineMs?: number },
) {
  const limit = options.limit ?? 10
  const deadline = Date.now() + (options.deadlineMs ?? 45_000)
  const results: ArcaInvoiceResult[] = []
  for (let index = 0; index < limit && Date.now() < deadline; index += 1) {
    const result = await processArcaInvoice(admin, options)
    if (result.status === "idle" || result.status === "busy") break
    results.push(result)
  }
  return {
    authorized: results.filter((result) => result.status === "authorized").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  }
}
