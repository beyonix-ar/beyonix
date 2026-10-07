"use client"

import { useState } from "react"
import { Printer } from "lucide-react"

import { AdminButton, AdminModal, AdminPrimaryButton, AdminTextInput } from "@/app/admin/components/admin-controls"
import type { LabelFormat, PrintableLabel } from "@/lib/barcodes/labels-document"
import { printLabels } from "@/lib/barcodes/print-labels"

export function LabelPrintDialog({ open, title, description, labels, allowCopies = false, onClose }: {
  open: boolean
  title: string
  description?: string
  labels: readonly PrintableLabel[]
  allowCopies?: boolean
  onClose: () => void
}) {
  const [copies, setCopies] = useState("1")
  const [format, setFormat] = useState<LabelFormat>("a4")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const copyCount = Number(copies)
  const validCopies = !allowCopies || (Number.isInteger(copyCount) && copyCount >= 1 && copyCount <= 500)

  async function print() {
    if (busy || !validCopies) return
    setBusy(true); setError("")
    try {
      await printLabels(allowCopies ? labels.map((label) => label.kind === "product" ? { ...label, copies: copyCount } : label) : labels, format)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudieron imprimir las etiquetas.")
    } finally {
      setBusy(false)
    }
  }

  return <AdminModal open={open} compact title={title} description={description} onClose={onClose} footer={<div className="flex justify-end gap-2"><AdminButton onClick={onClose}>Cancelar</AdminButton><AdminPrimaryButton icon={<Printer className="size-4" />} disabled={busy || !validCopies || labels.length === 0} onClick={() => void print()}>{busy ? "Preparando…" : "Imprimir"}</AdminPrimaryButton></div>}>
    <div className="space-y-3">
      {allowCopies && <div><p className="mb-1 text-xs font-black text-white">Cantidad de etiquetas</p><AdminTextInput title="Cantidad de etiquetas" placeholder="1" inputMode="numeric" value={copies} onChange={(value) => setCopies(value.replace(/\D/g, "").slice(0, 3))} /></div>}
      <fieldset>
        <legend className="mb-1 text-xs font-black text-white">Formato</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([["a4", "Hoja A4", "Impresora común, con líneas de corte"], ["single", "Etiqueta individual", "Una por página (impresora térmica)"]] as const).map(([value, label, hint]) => <label key={value} className={`flex cursor-pointer flex-col rounded-xl border p-3 text-sm ${format === value ? "border-beyonix-sky/60 bg-beyonix-blue/30" : "border-white/12"}`}><span className="flex items-center gap-2 font-bold text-white"><input type="radio" name="label-format" value={value} checked={format === value} onChange={() => setFormat(value)} />{label}</span><span className="mt-1 text-xs text-white/60">{hint}</span></label>)}
        </div>
      </fieldset>
      {error && <p role="alert" className="text-sm font-bold text-red-300">{error}</p>}
    </div>
  </AdminModal>
}
