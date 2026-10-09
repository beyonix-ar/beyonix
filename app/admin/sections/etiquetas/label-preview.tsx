"use client"

import { useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { AdminBadge, AdminButton, AdminModal } from "@/app/admin/components/admin-controls"
import type { LabelDrawing } from "@/lib/labels/drawing"
import { MM_TO_PT } from "@/lib/labels/drawing"
import { slotPosition, type LabelPlan } from "@/lib/labels/layout"
import type { LabelQueueItem } from "@/lib/labels/queue"
import type { LabelSettings } from "@/lib/labels/settings"
import { SYMBOLOGY_LABELS } from "@/lib/labels/symbology"

import { LabelGraphic } from "./label-graphic"

export const ROLL_PAGE_SIZE = 12
const ROLL_MARGIN_MM = 4

export function formatNumber(value: number, decimals = 1) {
  return value.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: decimals })
}

export function previewPageCount(plan: LabelPlan) {
  return plan.mode === "thermal" ? Math.max(1, Math.ceil(plan.totalLabels / ROLL_PAGE_SIZE)) : Math.max(1, plan.pages.length)
}

function SlotButton({ label, onSelect, children }: { label: string; onSelect: () => void; children: React.ReactNode }) {
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      className="cursor-zoom-in outline-none [&:focus-visible>rect:last-child]:stroke-sky-500"
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
    >
      {children}
    </g>
  )
}

// Vista previa a escala: la hoja (o el tramo de rollo) se dibuja en un SVG
// cuyo viewBox está en mm, así las proporciones son las físicas.
export function LabelSheetPreview({ plan, drawings, labels, settings, page, onSelect }: {
  plan: LabelPlan
  drawings: readonly LabelDrawing[]
  labels: readonly LabelQueueItem[]
  settings: LabelSettings
  page: number
  onSelect: (index: number) => void
}) {
  const describe = (index: number) => {
    const item = labels[index]
    return `Ampliar etiqueta ${index + 1}: ${item ? [item.productName, item.variantLabel].filter(Boolean).join(" · ") : ""}`
  }

  if (plan.mode === "thermal") {
    const rotate = settings.thermal.rotate
    const first = page * ROLL_PAGE_SIZE
    const indexes = Array.from({ length: Math.max(0, Math.min(ROLL_PAGE_SIZE, plan.totalLabels - first)) }, (_, offset) => first + offset)
    const pitch = settings.heightMm + settings.thermal.gapMm
    const width = settings.widthMm + ROLL_MARGIN_MM * 2
    const height = Math.max(1, indexes.length) * pitch - settings.thermal.gapMm + ROLL_MARGIN_MM * 2
    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="mx-auto block h-auto max-h-[70vh] w-full max-w-sm" role="img" aria-label={`Vista previa del rollo: ${plan.totalLabels} etiquetas`}>
        <rect width={width} height={height} fill="#e4e4e7" rx={1.5} />
        {indexes.map((index, offset) => {
          const y = ROLL_MARGIN_MM + offset * pitch
          return (
            <SlotButton key={index} label={describe(index)} onSelect={() => onSelect(index)}>
              <LabelGraphic drawing={drawings[index]} xMm={ROLL_MARGIN_MM} yMm={y} rotate={rotate} />
              <rect x={ROLL_MARGIN_MM} y={y} width={settings.widthMm} height={settings.heightMm} rx={0.8} fill="none" stroke="#a1a1aa" strokeWidth={0.2} />
            </SlotButton>
          )
        })}
      </svg>
    )
  }

  const sheet = plan.pages[page]
  const { pageWidthMm: width, pageHeightMm: height } = plan.grid
  const used = sheet?.slots.length ?? 0
  const free = page === plan.pages.length - 1 || !plan.pages.length ? plan.grid.perPage - used : 0
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mx-auto block h-auto w-full shadow-lg shadow-black/30" role="img" aria-label={`Vista previa de la hoja ${page + 1}: ${used} etiquetas`}>
      <rect width={width} height={height} fill="#fff" />
      <rect
        x={settings.a4.marginSideMm}
        y={settings.a4.marginTopMm}
        width={Math.max(0, width - 2 * settings.a4.marginSideMm)}
        height={Math.max(0, height - 2 * settings.a4.marginTopMm)}
        fill="none"
        stroke="#38bdf8"
        strokeOpacity={0.55}
        strokeWidth={0.35}
        strokeDasharray="2 1.5"
      />
      {sheet?.slots.map((slot) => (
        <SlotButton key={slot.index} label={describe(slot.index)} onSelect={() => onSelect(slot.index)}>
          <LabelGraphic drawing={drawings[slot.index]} xMm={slot.xMm} yMm={slot.yMm} />
          <rect x={slot.xMm} y={slot.yMm} width={settings.widthMm} height={settings.heightMm} fill="none" stroke="#a1a1aa" strokeWidth={0.2} strokeDasharray={settings.a4.cutMarks ? "1 1" : undefined} />
        </SlotButton>
      ))}
      {Array.from({ length: Math.max(0, free) }, (_, offset) => {
        const position = slotPosition(settings, plan.grid, used + offset)
        return <rect key={`free-${offset}`} x={position.xMm} y={position.yMm} width={settings.widthMm} height={settings.heightMm} fill="#f4f4f5" stroke="#d4d4d8" strokeWidth={0.2} strokeDasharray="1 1" />
      })}
    </svg>
  )
}

export function PreviewPager({ page, count, onChange, unit }: { page: number; count: number; onChange: (page: number) => void; unit: string }) {
  if (count <= 1) return null
  return (
    <div className="flex items-center justify-center gap-2 text-xs font-bold text-white/70">
      <AdminButton size="sm" aria-label="Anterior" disabled={page <= 0} onClick={() => onChange(page - 1)}><ChevronLeft className="size-4" /></AdminButton>
      <span>{unit} {page + 1} de {count}</span>
      <AdminButton size="sm" aria-label="Siguiente" disabled={page >= count - 1} onClick={() => onChange(page + 1)}><ChevronRight className="size-4" /></AdminButton>
    </div>
  )
}

function Measure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/8 py-1.5 text-sm">
      <dt className="text-white/58">{label}</dt>
      <dd className="text-right font-bold text-white">{value}</dd>
    </div>
  )
}

export function LabelZoomModal({ item, drawing, settings, onClose }: {
  item: LabelQueueItem | null
  drawing: LabelDrawing | null
  settings: LabelSettings
  onClose: () => void
}) {
  const [realSize, setRealSize] = useState(false)
  if (!item || !drawing) return null
  const barcode = drawing.barcode
  const rotate = settings.mode === "thermal" && settings.thermal.rotate
  const width = rotate ? drawing.heightMm : drawing.widthMm
  const height = rotate ? drawing.widthMm : drawing.heightMm
  return (
    <AdminModal
      open
      wide
      title="Etiqueta ampliada"
      description={[item.productName, item.variantLabel].filter(Boolean).join(" · ")}
      onClose={onClose}
      footer={<div className="flex justify-end"><AdminButton onClick={onClose}>Cerrar</AdminButton></div>}
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-3">
          <div className="flex min-h-48 items-center justify-center overflow-auto bg-zinc-200 p-4">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              style={realSize ? { width: `${width}mm`, height: `${height}mm` } : undefined}
              className={realSize ? "block shrink-0 shadow-md" : "block h-auto w-full max-w-xl shadow-md"}
              role="img"
              aria-label={`Etiqueta de ${formatNumber(width)} × ${formatNumber(height)} mm`}
            >
              <LabelGraphic drawing={drawing} rotate={rotate} />
            </svg>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs font-bold text-white/70">
            <input type="checkbox" className="size-4 accent-blue-500" checked={realSize} onChange={(event) => setRealSize(event.target.checked)} />
            Ver a tamaño real (aproximado: depende de la pantalla)
          </label>
        </div>
        <dl className="min-w-0">
          <Measure label="Etiqueta" value={`${formatNumber(width)} × ${formatNumber(height)} mm`} />
          {rotate && <Measure label="Diseño (girado 90°)" value={`${formatNumber(drawing.widthMm)} × ${formatNumber(drawing.heightMm)} mm`} />}
          <Measure label="Margen interno" value={`${formatNumber(drawing.paddingMm)} mm`} />
          {barcode ? (
            <>
              <Measure label="Código de barra" value={`${formatNumber(barcode.box.widthMm)} × ${formatNumber(barcode.box.heightMm)} mm`} />
              <Measure label="Tipo" value={SYMBOLOGY_LABELS[barcode.symbology]} />
              <Measure label="Barra mínima" value={`${formatNumber(barcode.moduleMm, 3)} mm${barcode.moduleDots ? ` · ${barcode.moduleDots} ${barcode.moduleDots === 1 ? "punto" : "puntos"} a ${settings.dpi} dpi` : ""}`} />
              <Measure label="Zona silenciosa" value={`${formatNumber(barcode.quietZoneMm.left)} / ${formatNumber(barcode.quietZoneMm.right)} mm`} />
            </>
          ) : (
            <Measure label="Código de barra" value="Generando…" />
          )}
          <div className="pt-3">
            <p className="mb-1.5 text-11px font-black uppercase tracking-widest text-beyonix-cyan">Texto</p>
            <ul className="space-y-1 text-sm">
              {drawing.texts.map((text, index) => (
                <li key={index} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate font-bold text-white">{text.text}</span>
                  <span className="shrink-0 text-xs text-white/55">{formatNumber(text.sizeMm * MM_TO_PT)} pt{text.bold ? " · negrita" : ""}</span>
                </li>
              ))}
              {!drawing.texts.length && <li className="text-white/55">Sin texto visible.</li>}
            </ul>
          </div>
          {drawing.warnings.length > 0 && (
            <div className="space-y-1.5 pt-3">
              {drawing.warnings.map((warning) => <AdminBadge key={warning.code} tone="warning" className="whitespace-normal normal-case tracking-normal">{warning.message}</AdminBadge>)}
            </div>
          )}
        </dl>
      </div>
    </AdminModal>
  )
}
