"use client"

import type { ReactNode } from "react"
import { CheckCircle2, Download, Eye, FileCode2, LoaderCircle, Printer, TriangleAlert } from "lucide-react"

import { AdminButton, AdminPrimaryButton, AdminSection } from "@/app/admin/components/admin-controls"
import type { LabelDrawing } from "@/lib/labels/drawing"
import type { LabelBatchOutput } from "@/lib/labels/history"
import type { LabelPlan, LayoutNotice } from "@/lib/labels/layout"
import type { LabelQueueItem } from "@/lib/labels/queue"
import type { LabelSettings } from "@/lib/labels/settings"

import { LabelSheetPreview, PreviewLegend, PreviewPager, formatNumber, previewPageCount } from "./label-preview"
import { describeFormat } from "./label-settings-panel"

export interface PrintStatus {
  tone: "ready" | "loading" | "blocked"
  text: string
}

function Metric({ label, value, help }: { label: string; value: ReactNode; help?: string }) {
  return (
    <div className="admin-label-metric flex items-baseline justify-between gap-3 py-2">
      <dt className="text-sm text-white/68">{label}</dt>
      <dd className="text-right">
        <span className="text-base font-black text-white" data-label-metric={label}>{value}</span>
        {help && <span className="block text-11px text-white/58">{help}</span>}
      </dd>
    </div>
  )
}

export function LabelPrintStep({ plan, drawings, labels, settings, page, onPage, onZoom, status, warnings, notices, busy, zplReason, onOutput }: {
  plan: LabelPlan
  drawings: readonly LabelDrawing[]
  labels: readonly LabelQueueItem[]
  settings: LabelSettings
  page: number
  onPage: (page: number) => void
  onZoom: (index: number) => void
  status: PrintStatus
  warnings: readonly string[]
  notices: readonly LayoutNotice[]
  busy: LabelBatchOutput | null
  zplReason: string | null
  onOutput: (output: LabelBatchOutput) => void
}) {
  const total = plan.totalLabels
  const thermal = plan.mode === "thermal"
  const blocked = status.tone !== "ready" || busy !== null
  const pageCount = previewPageCount(plan)
  const StatusIcon = status.tone === "ready" ? CheckCircle2 : status.tone === "loading" ? LoaderCircle : TriangleAlert

  return (
    <div className="grid items-start gap-5 *:min-w-0 lg:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
      <AdminSection compact icon={<Eye className="size-4" />} title="Vista previa" description={describeFormat(settings)}>
        {total > 0 ? (
          <div className="space-y-3">
            <div className="admin-label-stage p-3 sm:p-5">
              <div className={thermal ? "mx-auto max-w-md" : "mx-auto max-w-xl"}>
                <LabelSheetPreview plan={plan} drawings={drawings} labels={labels} settings={settings} page={page} onSelect={onZoom} />
              </div>
            </div>
            <PreviewPager page={page} count={pageCount} unit={thermal ? "Tramo" : "Hoja"} onChange={onPage} />
            <PreviewLegend mode={plan.mode} />
          </div>
        ) : (
          <p className="admin-label-empty px-4 py-12 text-center text-sm text-white/62">La tanda está vacía. Volvé al paso 1 para agregar productos.</p>
        )}
      </AdminSection>

      <AdminSection compact icon={<Printer className="size-4" />} title="Imprimir" className="lg:sticky lg:top-4">
        <p role={status.tone === "blocked" ? "alert" : "status"} className="admin-label-status flex items-center gap-2 px-3 py-2.5 text-sm font-bold" data-tone={status.tone}>
          <StatusIcon className={status.tone === "loading" ? "size-4 shrink-0 animate-spin" : "size-4 shrink-0"} aria-hidden="true" />
          {status.text}
        </p>

        <dl className="mt-3">
          <Metric label="Etiquetas" value={total} />
          {thermal ? (
            <>
              <Metric label="Por fila" value={plan.grid.columns} />
              <Metric label="Filas" value={plan.pages.length} help={plan.freeSlots ? `La última fila queda con ${plan.freeSlots} ${plan.freeSlots === 1 ? "lugar libre" : "lugares libres"}.` : undefined} />
              <Metric label="Largo de rollo" value={plan.rollLengthMm ? `${formatNumber(plan.rollLengthMm / 10)} cm` : "—"} />
            </>
          ) : (
            <>
              <Metric label="Por hoja" value={plan.grid.perPage ? `${plan.grid.perPage} (${plan.grid.columns} × ${plan.grid.rows})` : "—"} />
              <Metric label="Hojas" value={plan.pages.length} help={plan.freeSlots ? `${plan.freeSlots} ${plan.freeSlots === 1 ? "lugar libre" : "lugares libres"} en la última hoja.` : undefined} />
            </>
          )}
        </dl>

        {(warnings.length > 0 || notices.length > 0) && (
          <ul className="mt-3 space-y-1.5">
            {warnings.map((warning) => (
              <li key={warning} className="admin-label-status flex gap-2 px-3 py-2 text-xs" data-tone="warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {warning}
              </li>
            ))}
            {notices.map((notice) => (
              <li key={notice.message} className="admin-label-status px-3 py-2 text-xs" data-tone={notice.tone === "warning" ? "warning" : "info"}>{notice.message}</li>
            ))}
          </ul>
        )}

        <div className="mt-4 grid gap-2">
          <AdminPrimaryButton className="w-full" icon={<Printer className="size-4" />} disabled={blocked} onClick={() => onOutput("print")}>
            {busy === "print" ? "Preparando…" : `Imprimir ${total} ${total === 1 ? "etiqueta" : "etiquetas"}`}
          </AdminPrimaryButton>
          <div className={thermal ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
            <AdminButton icon={<Download className="size-4" />} disabled={blocked} onClick={() => onOutput("pdf")}>
              {busy === "pdf" ? "Generando…" : "Descargar PDF"}
            </AdminButton>
            {thermal && (
              <AdminButton icon={<FileCode2 className="size-4" />} title={zplReason ?? "ZPL para Zebra / Honeywell (beta, sin prueba en impresora física)"} disabled={blocked || Boolean(zplReason)} onClick={() => onOutput("zpl")}>
                {busy === "zpl" ? "Generando…" : "Exportar ZPL"}
              </AdminButton>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-white/62">
          En el diálogo de impresión elegí escala <strong className="text-white">100 %</strong> (“Tamaño real”), sin “Ajustar a la página”
          {thermal ? ` y papel de ${formatNumber(plan.grid.pageWidthMm)} × ${formatNumber(plan.grid.pageHeightMm)} mm sin márgenes.` : "."}
        </p>
      </AdminSection>
    </div>
  )
}
