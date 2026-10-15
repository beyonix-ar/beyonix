"use client"

import { useState } from "react"
import { Minus, Plus, Trash2 } from "lucide-react"

import { AdminButton } from "@/app/admin/components/admin-controls"
import { parseCopies } from "@/lib/labels/queue"
import { cn } from "@/lib/utils"

// Cantidad de etiquetas de un artículo: [−] [n] [+]. En 0 se muestra
// [+ Agregar]; restar desde 1 lo quita de la tanda.
export function LabelQuantity({ value, max, label, onChange, onRemove, className }: {
  value: number
  max: number
  /** Nombre del artículo para los textos accesibles. */
  label: string
  onChange: (copies: number) => void
  onRemove: () => void
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  if (value <= 0) {
    return (
      <AdminButton size="sm" className={cn("admin-label-add w-28 shrink-0", className)} icon={<Plus className="size-3.5" />} aria-label={`Agregar ${label}`} onClick={() => onChange(1)}>
        Agregar
      </AdminButton>
    )
  }
  const invalid = draft !== null && !parseCopies(draft, max)
  return (
    <div className={cn("admin-label-quantity flex w-28 shrink-0 items-center", className)} role="group" aria-label={`Cantidad de ${label}`}>
      <button
        type="button"
        className="admin-label-quantity-button"
        aria-label={value <= 1 ? `Quitar ${label} de la tanda` : `Restar una etiqueta de ${label}`}
        onClick={() => (value <= 1 ? onRemove() : onChange(value - 1))}
      >
        {value <= 1 ? <Trash2 className="size-3.5" /> : <Minus className="size-3.5" />}
      </button>
      <input
        aria-label={`Cantidad de etiquetas de ${label}`}
        inputMode="numeric"
        value={draft ?? String(value)}
        className={cn("admin-label-quantity-input", invalid && "text-red-300")}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur() }}
        onChange={(event) => {
          const clean = event.target.value.replace(/\D/g, "").slice(0, 3)
          setDraft(clean)
          const copies = parseCopies(clean, max)
          if (copies) onChange(copies)
        }}
      />
      <button
        type="button"
        className="admin-label-quantity-button"
        aria-label={`Sumar una etiqueta de ${label}`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
