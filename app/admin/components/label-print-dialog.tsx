"use client"

import { useState } from "react"
import { Download, Printer } from "lucide-react"

import { AdminButton, AdminModal, AdminPrimaryButton, AdminTextInput } from "@/app/admin/components/admin-controls"
import type { LabelFormat, PrintableLabel } from "@/lib/barcodes/labels-document"
import { printLabels, saveBatchLabelsPdf } from "@/lib/barcodes/print-labels"

export function LabelPrintDialog({ open, title, description, labels, allowCopies = false, onClose, onPrinted }: {
  open: boolean
  title: string
  description?: string
  labels: readonly PrintableLabel[]
  allowCopies?: boolean
  onClose: () => void
  onPrinted?: () => void
}) {
  const [copies, setCopies] = useState("1")
  const [format, setFormat] = useState<LabelFormat | null>(null)
  const selectedFormat = format ?? (labels.length > 0 && labels.every((label) => label.kind === "parcel" || label.kind === "prepared" || label.kind === "batch") ? "single" : "a4")
  const [busy, setBusy] = useState<"print" | "pdf" | null>(null)
  const [error, setError] = useState("")
  const copyCount = Number(copies)
  const validCopies = !allowCopies || (Number.isInteger(copyCount) && copyCount >= 1 && copyCount <= 500)

  const batchLabels = labels.filter((label) => label.kind === "batch")
  const canSavePdf = batchLabels.length > 0 && batchLabels.length === labels.length

  async function output(mode: "print" | "pdf") {
    if (busy || !validCopies) return
    setBusy(mode); setError("")
    try {
      if (mode === "pdf") await saveBatchLabelsPdf(batchLabels.map((label) => label.code), selectedFormat)
      else {
        await printLabels(allowCopies ? labels.map((label) => label.kind === "product" ? { ...label, copies: copyCount } : label) : labels, selectedFormat)
        onPrinted?.()
      }
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo preparar la etiqueta.")
    } finally {
      setBusy(null)
    }
  }

  return <AdminModal open={open} compact title={title} description={description} onClose={onClose} footer={<div className="flex flex-wrap justify-end gap-2"><AdminButton onClick={onClose}>Cancelar</AdminButton><AdminPrimaryButton icon={<Printer className="size-4" />} disabled={busy !== null || !validCopies || labels.length === 0} onClick={() => void output("print")}>{busy === "print" ? "Preparando…" : "Imprimir"}</AdminPrimaryButton>{canSavePdf && <AdminButton icon={<Download className="size-4" />} disabled={busy !== null || !validCopies} onClick={() => void output("pdf")}>{busy === "pdf" ? "Generando…" : "Guardar PDF"}</AdminButton>}</div>}>
    <div className="dispatch-label-print-options space-y-3">
      {allowCopies && <div><p className="mb-1 text-xs font-black text-white">Cantidad de etiquetas</p><AdminTextInput title="Cantidad de etiquetas" placeholder="1" inputMode="numeric" value={copies} onChange={(value) => setCopies(value.replace(/\D/g, "").slice(0, 3))} /></div>}
      <fieldset>
        <legend className="mb-1 text-xs font-black text-white">Formato</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([["a4", "Hoja A4", "Impresora común, con líneas de corte"], ["single", "Etiqueta individual", "Una por página (impresora térmica)"]] as const).map(([value, label, hint]) => <label key={value} className={`flex cursor-pointer flex-col rounded-xl border p-3 text-sm ${selectedFormat === value ? "border-beyonix-sky/60 bg-beyonix-blue/30" : "border-white/12"}`}><span className="flex items-center gap-2 font-bold text-white"><input type="radio" name="label-format" value={value} checked={selectedFormat === value} onChange={() => setFormat(value)} />{label}</span><span className="mt-1 text-xs text-white/60">{hint}</span></label>)}
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm font-bold text-red-300">{error}</p>}
    </div>
  </AdminModal>
}
