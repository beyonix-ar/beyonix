import { NextResponse } from "next/server"

import type { CreditNoteArcaResult } from "@/lib/arca/credit-note-emission"

/** Respuesta HTTP para una emisión de NC que no terminó autorizada. */
export function creditNoteEmissionFailureResponse(
  emission: Exclude<CreditNoteArcaResult, { status: "authorized" }>,
  orderId: number,
  noteId: string,
) {
  switch (emission.status) {
    case "busy":
      return NextResponse.json(
        { error: "Esta nota de crédito ya se está emitiendo. Esperá a que termine." },
        { status: 409 },
      )
    case "already_finalized":
      return NextResponse.json({ error: "La nota de crédito ya fue emitida." }, { status: 409 })
    case "released":
      return NextResponse.json({ error: "La nota de crédito requiere revisión antes de reintentar." }, { status: 409 })
    case "failed":
      console.error("ARCA_CREDIT_NOTE_EMISSION_FAILED", { orderId, noteId, outcome: emission.outcome })
      if (emission.outcome === "rejected") {
        return NextResponse.json(
          { error: "No se pudo emitir la nota de crédito. Revisá la gestión antes de reintentar." },
          { status: 502 },
        )
      }
      return NextResponse.json(
        {
          error:
            emission.outcome === "manual_review"
              ? "ARCA tiene ese comprobante con otros datos. Requiere revisión manual: no se emitió otra nota."
              : "El resultado de ARCA requiere conciliación. Usá “Conciliar con ARCA” antes de volver a emitir.",
          reconciliation_required: true,
          note_id: noteId,
        },
        { status: 409 },
      )
  }
}
