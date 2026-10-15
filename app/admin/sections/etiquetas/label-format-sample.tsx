"use client"

import { ChevronLeft, ChevronRight, ScanEye } from "lucide-react"

import { AdminButton, AdminPrimaryButton, AdminSection } from "@/app/admin/components/admin-controls"
import { buildLabelDrawing, type LabelDrawing } from "@/lib/labels/drawing"
import { thermalDesignSize } from "@/lib/labels/layout"
import type { LabelSettings } from "@/lib/labels/settings"

import { LabelFormatDiagram } from "./label-format-diagram"
import { LabelGraphic } from "./label-graphic"
import { formatNumber } from "./label-preview"
import { formatLayoutSummary, formatName } from "./label-settings-panel"

const SAMPLE = { name: "NOMBRE PRODUCTO", variant: "NEGRO", sku: "AP01", code: "7790001000019" }

// Columna derecha del paso 2: cómo sale una etiqueta (la primera de la tanda o
// un ejemplo) y el esquema del formato elegido, actualizados en vivo.
export function LabelFormatSample({ settings, drawing, onBack, onContinue }: {
  settings: LabelSettings
  drawing: LabelDrawing | undefined
  onBack: () => void
  onContinue: () => void
}) {
  const size = settings.mode === "thermal" ? thermalDesignSize(settings) : { widthMm: settings.widthMm, heightMm: settings.heightMm }
  const shown = drawing ?? buildLabelDrawing(SAMPLE, null, settings, size)
  const rotate = settings.mode === "thermal" && settings.thermal.rotate
  const width = rotate ? shown.heightMm : shown.widthMm
  const height = rotate ? shown.widthMm : shown.heightMm
  return (
    <AdminSection compact icon={<ScanEye className="size-4" />} title="Así queda" description={drawing ? "Primera etiqueta de tu tanda." : "Ejemplo: agregá productos para ver los tuyos."} className="lg:sticky lg:top-4">
      <div className="admin-label-stage flex items-center justify-center p-5">
        <svg viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full max-w-xs shadow-md" role="img" aria-label={`Etiqueta de ${formatNumber(width)} × ${formatNumber(height)} mm`}>
          <LabelGraphic drawing={shown} rotate={rotate} />
        </svg>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="flex w-20 shrink-0 justify-center">
          <LabelFormatDiagram settings={settings} className="max-h-24 w-full" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-black text-white" data-format-name>{formatName(settings)}</p>
          <p className="text-xs text-white/62" data-format-layout>{formatLayoutSummary(settings)}</p>
          {drawing?.warnings[0] && <p className="mt-1 text-xs text-amber-300">{drawing.warnings[0].message}</p>}
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <AdminButton icon={<ChevronLeft className="size-4" />} onClick={onBack}>Productos</AdminButton>
        <AdminPrimaryButton className="flex-1" onClick={onContinue}>
          Ver e imprimir
          <ChevronRight className="size-4" />
        </AdminPrimaryButton>
      </div>
    </AdminSection>
  )
}
