import { NextResponse } from "next/server"

import { requireAdmin } from "@/app/api/admin/clientes/_auth"
import {
  arcaConfigurationErrorResponse,
  requireArcaConfiguration,
  type ArcaConfiguration,
} from "@/lib/arca/configuration"
import { reconcileCreditNote } from "@/lib/arca/credit-note-emission"
import { ArcaConfigurationError } from "@/lib/arca/environment"
import { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"
import { finalizeCreditNote } from "@/lib/orders/credit-note-finalization"

export const runtime = "nodejs"

/**
 * "Conciliar con ARCA" para una Nota de Crédito colgada (respuesta perdida,
 * reinicio, fallo al guardar o al completar pasos posteriores). NUNCA pide
 * un CAE nuevo: adopta la NC que ARCA ya autorizó (mismo importe), la deja
 * en revisión manual si ARCA tiene ese número con otros datos, o la libera
 * para volver a emitirla por el flujo normal. Después completa, de forma
 * idempotente, stock / saldo / resumen del pedido.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ noteId: string }> },
) {
  const auth = await requireAdmin(request)
  if ("error" in auth) return auth.error

  const { noteId } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noteId)) {
    return NextResponse.json({ error: "Nota de crédito inválida." }, { status: 400 })
  }

  // Guard central: conciliar también consulta ARCA con el certificado.
  let configuration: ArcaConfiguration
  try {
    configuration = requireArcaConfiguration()
  } catch (error) {
    if (error instanceof ArcaConfigurationError) return arcaConfigurationErrorResponse(error)
    throw error
  }

  let result
  try {
    result = await reconcileCreditNote(auth.admin, { noteId, gateway: createWsfeInvoiceGateway(configuration) })
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (/CREDIT_NOTE_NOT_FOUND/.test(message)) {
      return NextResponse.json({ error: "Nota de crédito no encontrada." }, { status: 404 })
    }
    if (/CREDIT_NOTE_NOT_PROCESSING/.test(message)) {
      return NextResponse.json({ error: "La nota de crédito no está pendiente de conciliación." }, { status: 409 })
    }
    console.error("CREDIT_NOTE_RECONCILE_ERROR", { noteId, message })
    return NextResponse.json({ error: "No se pudo conciliar la nota de crédito." }, { status: 500 })
  }

  switch (result.status) {
    case "authorized": {
      try {
        const finalized = await finalizeCreditNote(auth.admin, { noteId, actorId: auth.user.id })
        return NextResponse.json({
          reconciled: true,
          adopted: !result.resumed,
          order: { ...finalized.order, order_credit_notes: finalized.authorizedNotes },
          note: finalized.note,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : "Error posterior a la autorización."
        console.error("CREDIT_NOTE_RECONCILE_FINALIZATION_ERROR", { noteId, message })
        return NextResponse.json(
          { error: `${message} Reintentá la conciliación: no se emite otra nota.`, note_authorized: true },
          { status: 500 },
        )
      }
    }
    case "already_finalized":
      return NextResponse.json({ reconciled: true, already_finalized: true })
    case "busy":
      return NextResponse.json(
        { error: "La nota de crédito se está procesando. Esperá a que termine." },
        { status: 409 },
      )
    case "released":
      return NextResponse.json({ reconciled: true, released: true, message: result.error })
    case "failed":
      return NextResponse.json(
        {
          error:
            result.outcome === "manual_review"
              ? "ARCA tiene ese comprobante con otros datos. Requiere revisión manual: no se adoptó ni se emitió otra nota."
              : `No se pudo consultar ARCA: ${result.error}`,
          reconciliation_required: true,
        },
        { status: result.outcome === "manual_review" ? 409 : 502 },
      )
  }
}
