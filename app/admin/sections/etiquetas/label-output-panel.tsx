"use client"

import { CheckCircle2, Eye, Maximize2, TriangleAlert } from "lucide-react"

import { AdminButton, AdminInfoBlock } from "@/app/admin/components/admin-controls"
import type { LabelDrawing } from "@/lib/labels/drawing"
import type { LabelPlan, LayoutNotice } from "@/lib/labels/layout"
import type { LabelQueueItem } from "@/lib/labels/queue"
import type { LabelSettings } from "@/lib/labels/settings"

import { LabelSheetPreview, PreviewLegend, PreviewPager, formatNumber } from "./label-preview"
import { LABEL_STEP_IDS, LabelStepSection, StatTile, plural } from "./label-ui"

export interface PrintBlocker {
  text: string
  /** Bloqueos transitorios (p. ej. generando códigos) se muestran como info. */
  pending: boolean
}

export function describeOutput(plan: LabelPlan) {
  if (plan.mode === "a4") return plural(plan.pages.length, "hoja A4", "hojas A4")
  return `${plural(plan.pages.length, "fila", "filas")} de rollo`
}

function PlanStats({ plan, settings }: { plan: LabelPlan; settings: LabelSettings }) {
  if (plan.mode === "a4") {
    return (
      <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
        <StatTile label="Etiquetas" value={plan.totalLabels} tone="accent" />
        <StatTile label="Por hoja" value={plan.grid.perPage || "—"} hint={plan.grid.perPage ? `${plan.grid.columns} columnas × ${plan.grid.rows} filas` : "No entra"} />
        <StatTile label="Hojas" value={plan.pages.length} />
        <StatTile label="Libres" value={plan.freeSlots} hint={plan.totalLabels ? `${plan.unusedPercent} % del papel sin usar` : undefined} tone={plan.freeSlots ? "default" : "muted"} />
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
      <StatTile label="Etiquetas" value={plan.totalLabels} tone="accent" />
      <StatTile label="Por fila" value={plan.grid.columns} hint={`Fila de ${formatNumber(plan.grid.pageWidthMm)} mm`} />
      <StatTile label="Filas" value={plan.pages.length} hint={plan.freeSlots ? `${plural(plan.freeSlots, "lugar libre", "lugares libres")} al final` : undefined} />
      <StatTile label="Largo" value={plan.rollLengthMm ? `${formatNumber(plan.rollLengthMm / 10)} cm` : "—"} hint={`${settings.dpi} dpi`} />
    </div>
  )
}

export function LabelOutputPanel({ plan, drawings, labels, settings, total, page, pageCount, blocker, warnings, notices, onPage, onZoom, onExpand, className }: {
  plan: LabelPlan
  drawings: readonly LabelDrawing[]
  labels: readonly LabelQueueItem[]
  settings: LabelSettings
  total: number
  page: number
  pageCount: number
  blocker: PrintBlocker | null
  warnings: readonly string[]
  notices: readonly LayoutNotice[]
  onPage: (page: number) => void
  onZoom: (index: number) => void
  onExpand: () => void
  className?: string
}) {
  const sample = drawings[0]
  const unit = plan.mode === "thermal" ? "Tramo" : "Hoja"
  const sizeLine = `Cada etiqueta ${formatNumber(plan.designWidthMm)} × ${formatNumber(plan.designHeightMm)} mm${sample?.barcode ? ` · barras ${formatNumber(sample.barcode.box.widthMm)} × ${formatNumber(sample.barcode.box.heightMm)} mm` : ""}`
  return (
    <LabelStepSection
      id={LABEL_STEP_IDS.output}
      step={3}
      title="Previsualización"
      description={sizeLine}
      actions={<AdminButton size="sm" icon={<Maximize2 className="size-3.5" />} disabled={!total} onClick={onExpand}>Ampliar</AdminButton>}
      className={className}
    >
      <div className="space-y-4">
        <PlanStats plan={plan} settings={settings} />

        {total > 0 && (
          blocker ? (
            <AdminInfoBlock role={blocker.pending ? "status" : "alert"} tone={blocker.pending ? "info" : "danger"} icon={<TriangleAlert className="size-4" aria-hidden="true" />}>{blocker.text}</AdminInfoBlock>
          ) : (
            <AdminInfoBlock role="status" tone="success" icon={<CheckCircle2 className="size-4" aria-hidden="true" />}>
              Listo para imprimir: {plural(plan.totalLabels, "etiqueta")} en {describeOutput(plan)}.
            </AdminInfoBlock>
          )
        )}
        {warnings.map((warning) => (
          <AdminInfoBlock key={warning} tone="warning" icon={<TriangleAlert className="size-4" aria-hidden="true" />}>{warning}</AdminInfoBlock>
        ))}
        {notices.map((notice) => <AdminInfoBlock key={notice.message} tone={notice.tone}>{notice.message}</AdminInfoBlock>)}

        {total > 0 ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-zinc-300/70 p-3 sm:p-5">
              <div className="mx-auto max-w-md">
                <LabelSheetPreview plan={plan} drawings={drawings} labels={labels} settings={settings} page={page} onSelect={onZoom} />
              </div>
            </div>
            <PreviewPager page={page} count={pageCount} unit={unit} onChange={onPage} />
            <PreviewLegend mode={plan.mode} />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl bg-white/4 px-4 py-12 text-center">
            <Eye className="size-8 text-white/30" aria-hidden="true" />
            <p className="text-sm font-black text-white">Todavía no hay nada para mostrar</p>
            <p className="max-w-xs text-xs leading-5 text-white/55">Cuando agregues etiquetas a la cola vas a ver acá la {plan.mode === "a4" ? "hoja" : "tira del rollo"} tal como sale de la impresora.</p>
          </div>
        )}

        {total > 0 && (
          <p className="text-xs leading-5 text-white/55">
            {plan.mode === "a4"
              ? "Al imprimir elegí escala 100 % (“Tamaño real”), sin “Ajustar a la página”."
              : `Al imprimir elegí un papel de ${formatNumber(plan.grid.pageWidthMm)} × ${formatNumber(plan.grid.pageHeightMm)} mm, escala 100 % y sin márgenes.`}
          </p>
        )}
      </div>
    </LabelStepSection>
  )
}
