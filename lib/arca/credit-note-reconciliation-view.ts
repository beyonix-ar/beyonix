export type ReconcilableCreditNote = {
  id: string
  status?: string | null
  error?: string | null
  finalized_at?: string | null
  voucher_point?: number | null
  voucher_number?: number | string | null
}

/**
 * NC que quedaron a mitad de camino con ARCA: 'processing' (resultado
 * desconocido o revisión manual) o autorizadas sin completar sus pasos
 * posteriores. Mientras se está emitiendo una, no se ofrece conciliar.
 * Sin la columna finalized_at (migración no aplicada) nunca marca una NC
 * autorizada.
 */
export function getNotesPendingReconciliation<T extends ReconcilableCreditNote>(notes: T[], saving: boolean) {
  if (saving) return []
  return notes.filter(
    (note) =>
      note.status === "processing" ||
      (note.status === "authorized" && "finalized_at" in note && note.finalized_at == null),
  )
}
