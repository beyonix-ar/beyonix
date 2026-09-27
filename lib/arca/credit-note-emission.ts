/**
 * Nota de Crédito C — comunicación con ARCA, con el mismo principio que la
 * Factura C (lib/arca/invoice-automation.ts): una NC autorizada NUNCA se
 * emite dos veces.
 *
 *   1. claim_credit_note_arca: lease por NC (doble click / dos procesos ->
 *      uno solo avanza). La numeración ya está serializada por
 *      order_credit_notes_single_processing (una NC 'processing' en toda la
 *      tienda).
 *   2. record_credit_note_request persiste número, importe, fecha y ambiente
 *      ARCA ANTES de FECAESolicitar; la base exige que sea el mismo ambiente
 *      de la Factura C asociada. Nunca se concilia en otro ambiente.
 *   3. Si ya había un número pedido (respuesta perdida, reinicio), primero se
 *      consulta ARCA: mismo importe, misma Factura C asociada (CbtesAsoc) y
 *      misma fecha pedida -> se ADOPTA; otros datos o faltantes -> revisión
 *      manual (fail-closed); ARCA no lo tiene -> se libera.
 *   4. complete_credit_note_authorization es idempotente.
 *
 * La relación Factura -> NC viaja en CbtesAsoc y queda en
 * invoice_point/invoice_number de la NC.
 */

import { parseArcaEnvironment, type ArcaEnvironment } from "./environment.ts"
import type { ArcaInvoiceGateway } from "./invoice-automation.ts"
import { FACTURA_C_VOUCHER_TYPE, argentinaDate } from "./invoice-automation.ts"
import type { AuthorizedVoucher } from "./wsfe.ts"

export const NOTA_CREDITO_C_VOUCHER_TYPE = 13
const LEASE = "10 minutes"

interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: { message: string } | null
  }>
}

export interface ClaimedCreditNote {
  id: string
  order_id: number
  status: string
  total_amount: number | string
  voucher_point: number | null
  voucher_number: number | string | null
  cae: string | null
  cae_due: string | null
  authorized_at: string | null
  requested_total: number | string | null
  requested_date: string | null
  invoice_point: number | null
  invoice_number: number | string | null
  arca_environment: string | null
  finalized_at: string | null
}

export interface CreditNoteAuthorization {
  environment: ArcaEnvironment
  pointOfSale: number
  voucherNumber: number
  cae: string
  caeDue: string
  issueDate: string
  reconciled: boolean
}

export type CreditNoteArcaResult =
  | { status: "authorized"; authorization: CreditNoteAuthorization; resumed: boolean }
  | { status: "busy" }
  | { status: "already_finalized" }
  | { status: "released"; error: string }
  | { status: "failed"; outcome: "rejected" | "unknown" | "manual_review"; error: string }

export interface AssociatedInvoice {
  /** Ambiente ARCA en el que se autorizó la Factura C (ordenes.invoice_arca_environment). */
  environment: ArcaEnvironment | null
  pointOfSale: number
  voucherNumber: number
  voucherDate: string | null
}

class CreditNoteRpcError extends Error {}

function cents(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : Number.NaN
}

function arcaDateToIso(value: string | null | undefined) {
  if (!value || !/^\d{8}$/.test(value)) throw new Error("ARCA devolvió una fecha inválida.")
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

function isoDate(value: string | null | undefined) {
  return value ? String(value).slice(0, 10) : ""
}

async function rpc<T>(admin: RpcClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(name, args)
  if (error) throw new CreditNoteRpcError(error.message)
  return (Array.isArray(data) ? data[0] : data) as T
}

async function claim(admin: RpcClient, noteId: string) {
  try {
    return await rpc<ClaimedCreditNote>(admin, "claim_credit_note_arca", { p_note_id: noteId, p_lease: LEASE })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/CREDIT_NOTE_ALREADY_PROCESSING/.test(message)) return "busy" as const
    if (/CREDIT_NOTE_ALREADY_FINALIZED/.test(message)) return "already_finalized" as const
    throw error
  }
}

async function fail(
  admin: RpcClient,
  noteId: string,
  error: string,
  outcome: "rejected" | "unknown" | "manual_review",
): Promise<CreditNoteArcaResult> {
  await rpc(admin, "fail_credit_note_arca_attempt", { p_note_id: noteId, p_error: error, p_outcome: outcome })
  console.error("ARCA_CREDIT_NOTE_ATTEMPT_FAILED", { noteId, outcome, error })
  return { status: "failed", outcome, error }
}

async function complete(
  admin: RpcClient,
  noteId: string,
  authorization: CreditNoteAuthorization,
): Promise<CreditNoteArcaResult> {
  await rpc(admin, "complete_credit_note_authorization", {
    p_note_id: noteId,
    p_point: authorization.pointOfSale,
    p_number: authorization.voucherNumber,
    p_cae: authorization.cae,
    p_cae_due: authorization.caeDue,
    p_authorized_at: new Date(`${authorization.issueDate}T12:00:00-03:00`).toISOString(),
    p_reconciled: authorization.reconciled,
    p_environment: authorization.environment,
  })
  return { status: "authorized", authorization, resumed: false }
}

function authorizedFromRow(note: ClaimedCreditNote): CreditNoteArcaResult {
  return {
    status: "authorized",
    resumed: true,
    authorization: {
      // La base exige ambiente en toda NC autorizada; si faltara se trata
      // como prueba, nunca como fiscal.
      environment: parseArcaEnvironment(note.arca_environment) ?? "homologation",
      pointOfSale: Number(note.voucher_point),
      voucherNumber: Number(note.voucher_number),
      cae: String(note.cae),
      caeDue: isoDate(note.cae_due),
      issueDate: isoDate(note.authorized_at),
      reconciled: true,
    },
  }
}

/**
 * El comprobante que ARCA tiene con ese número es ESTA nota: mismo importe,
 * asociado únicamente a la Factura C de esta nota (FECompConsultar informa
 * CbtesAsoc) y, si se registró, la misma fecha pedida. Cualquier diferencia
 * o dato faltante es fail-closed.
 */
function matchesRequestedNote(
  voucher: AuthorizedVoucher | null,
  note: ClaimedCreditNote,
): voucher is AuthorizedVoucher & { cae: string; caeDueDate: string } {
  if (!voucher?.cae || !voucher.caeDueDate) return false
  if (cents(voucher.total) !== cents(note.requested_total ?? note.total_amount)) return false
  if (note.requested_date && voucher.voucherDate !== note.requested_date) return false
  const associated = voucher.associatedVouchers ?? []
  return (
    associated.length === 1 &&
    associated[0].voucherType === FACTURA_C_VOUCHER_TYPE &&
    associated[0].pointOfSale === Number(note.invoice_point) &&
    associated[0].voucherNumber === Number(note.invoice_number)
  )
}

/**
 * ¿ARCA autorizó el número pedido? Adopta, marca revisión manual o informa
 * que no existe (sin tocar nada en ese último caso).
 */
async function reconcileRequested(
  admin: RpcClient,
  note: ClaimedCreditNote,
  gateway: ArcaInvoiceGateway,
): Promise<CreditNoteArcaResult | "not_authorized"> {
  const point = Number(note.voucher_point)
  const number = Number(note.voucher_number)
  // Un número pedido en otro ambiente no existe en éste: ni se adopta ni se
  // libera consultando acá.
  if (note.arca_environment !== gateway.environment) {
    return fail(
      admin,
      note.id,
      `La NC ${point}-${number} se pidió en ARCA ${note.arca_environment ?? "sin ambiente"} y la aplicación está en ${gateway.environment}. No se concilia entre ambientes.`,
      "manual_review",
    )
  }
  const last = await gateway.lastAuthorized(point, NOTA_CREDITO_C_VOUCHER_TYPE)
  if (last < number) return "not_authorized"

  const voucher = await gateway.consult(point, number, NOTA_CREDITO_C_VOUCHER_TYPE)
  if (matchesRequestedNote(voucher, note)) {
    return complete(admin, note.id, {
      environment: gateway.environment,
      pointOfSale: point,
      voucherNumber: number,
      cae: voucher.cae,
      caeDue: arcaDateToIso(voucher.caeDueDate),
      issueDate: arcaDateToIso(voucher.voucherDate),
      reconciled: true,
    })
  }
  return fail(
    admin,
    note.id,
    `ARCA tiene autorizada la NC ${point}-${number} con otros datos. No se adopta ni se vuelve a emitir.`,
    "manual_review",
  )
}

/**
 * Emite la NC reservada por begin_partial_credit_note. Reintentos,
 * doble click o un proceso que retoma después de un reinicio nunca generan
 * un segundo comprobante.
 */
export async function emitCreditNote(
  admin: RpcClient,
  {
    noteId,
    gateway,
    pointOfSale,
    associatedInvoice,
    now = () => new Date(),
  }: {
    noteId: string
    gateway: ArcaInvoiceGateway
    pointOfSale: number
    associatedInvoice: AssociatedInvoice
    now?: () => Date
  },
): Promise<CreditNoteArcaResult> {
  const claimed = await claim(admin, noteId)
  if (typeof claimed === "string") return { status: claimed }
  const note = claimed
  if (note.status === "authorized") return authorizedFromRow(note)
  // ¿Ya existe (o se registró en este intento) un número pedido a ARCA?
  let requested = note.voucher_number != null

  try {
    if (note.voucher_number != null) {
      const reconciled = await reconcileRequested(admin, note, gateway)
      if (reconciled !== "not_authorized") return reconciled
      // ARCA no lo tiene: se libera (la reserva de importes también) y el
      // Admin vuelve a emitir desde el flujo normal, con datos frescos.
      await rpc(admin, "fail_credit_note_arca_attempt", {
        p_note_id: noteId,
        p_error: "ARCA no autorizó el número pedido anteriormente. Volvé a emitir la nota.",
        p_outcome: "rejected",
      })
      return { status: "released", error: "ARCA no había autorizado la nota. Podés volver a emitirla." }
    }

    // La NC vive en el ambiente de su factura (la base también lo exige).
    if (associatedInvoice.environment !== gateway.environment) {
      return fail(
        admin,
        noteId,
        `La Factura C asociada es de ARCA ${associatedInvoice.environment ?? "sin ambiente"} y la aplicación está en ${gateway.environment}: no se puede emitir la nota de crédito en otro ambiente.`,
        "rejected",
      )
    }

    const total = cents(note.total_amount) / 100
    const last = await gateway.lastAuthorized(pointOfSale, NOTA_CREDITO_C_VOUCHER_TYPE)
    const lastVoucher = await gateway.consult(pointOfSale, last, NOTA_CREDITO_C_VOUCHER_TYPE)
    const issueDate = argentinaDate(now())
    if (lastVoucher && issueDate.arca < lastVoucher.voucherDate) {
      return fail(admin, noteId, "La fecha del comprobante no puede ser anterior a la última autorizada por ARCA.", "rejected")
    }

    const voucherNumber = last + 1
    await rpc(admin, "record_credit_note_request", {
      p_note_id: noteId,
      p_point: pointOfSale,
      p_number: voucherNumber,
      p_total: total,
      p_date: issueDate.arca,
      p_environment: gateway.environment,
    })
    requested = true

    let result
    try {
      result = await gateway.requestCae({
        pointOfSale,
        voucherType: NOTA_CREDITO_C_VOUCHER_TYPE,
        voucherNumber,
        voucherDate: issueDate.arca,
        total,
        associatedVoucher: {
          voucherType: FACTURA_C_VOUCHER_TYPE,
          pointOfSale: associatedInvoice.pointOfSale,
          voucherNumber: associatedInvoice.voucherNumber,
          voucherDate: associatedInvoice.voucherDate,
        },
      })
    } catch (error) {
      return fail(
        admin,
        noteId,
        gateway.describeError(error),
        gateway.isDefinitiveRejection(error) ? "rejected" : "unknown",
      )
    }

    if (result.voucherNumber !== voucherNumber) {
      return fail(
        admin,
        noteId,
        `ARCA autorizó la NC ${result.voucherNumber} en lugar de la ${voucherNumber}.`,
        "manual_review",
      )
    }

    return await complete(admin, noteId, {
      environment: gateway.environment,
      pointOfSale,
      voucherNumber,
      cae: result.cae,
      caeDue: arcaDateToIso(result.caeDueDate),
      issueDate: issueDate.iso,
      reconciled: false,
    })
  } catch (error) {
    // Falla fuera de la solicitud de CAE. Sin número pedido, ARCA nunca la
    // recibió: se libera. Con número pedido (p. ej. falló guardar el CAE),
    // queda para conciliar.
    const message = gateway.describeError(error)
    const outcome = requested ? "unknown" : "rejected"
    try {
      return await fail(admin, noteId, message, outcome)
    } catch (failError) {
      console.error("ARCA_CREDIT_NOTE_FAIL_RECORD_ERROR", { noteId, message, failError })
      return { status: "failed", outcome, error: message }
    }
  }
}

/**
 * Conciliación manual/automática de una NC colgada. NUNCA pide un CAE nuevo:
 * adopta lo que ARCA ya autorizó, marca revisión manual o libera la NC para
 * que el Admin la vuelva a emitir por el flujo normal.
 */
export async function reconcileCreditNote(
  admin: RpcClient,
  { noteId, gateway }: { noteId: string; gateway: ArcaInvoiceGateway },
): Promise<CreditNoteArcaResult> {
  const claimed = await claim(admin, noteId)
  if (typeof claimed === "string") return { status: claimed }
  const note = claimed
  if (note.status === "authorized") return authorizedFromRow(note)

  try {
    if (note.voucher_number == null) {
      // Se cortó antes de pedir el CAE: ARCA nunca recibió esta NC.
      await rpc(admin, "fail_credit_note_arca_attempt", {
        p_note_id: noteId,
        p_error: "La emisión se interrumpió antes de contactar a ARCA. Volvé a emitir la nota.",
        p_outcome: "rejected",
      })
      return { status: "released", error: "La nota no llegó a ARCA. Podés volver a emitirla." }
    }
    const reconciled = await reconcileRequested(admin, note, gateway)
    if (reconciled !== "not_authorized") return reconciled
    await rpc(admin, "fail_credit_note_arca_attempt", {
      p_note_id: noteId,
      p_error: "ARCA no autorizó el número pedido. Volvé a emitir la nota.",
      p_outcome: "rejected",
    })
    return { status: "released", error: "ARCA no había autorizado la nota. Podés volver a emitirla." }
  } catch (error) {
    const message = gateway.describeError(error)
    try {
      return await fail(admin, noteId, message, "unknown")
    } catch (failError) {
      console.error("ARCA_CREDIT_NOTE_FAIL_RECORD_ERROR", { noteId, message, failError })
      return { status: "failed", outcome: "unknown", error: message }
    }
  }
}
