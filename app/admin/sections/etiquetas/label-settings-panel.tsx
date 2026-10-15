"use client"

import { useState, type ReactNode } from "react"
import { ChevronRight, FileText, PencilRuler, Printer, Ruler, Save, Trash2 } from "lucide-react"

import {
  AdminButton,
  AdminDangerButton,
  AdminModal,
  AdminPrimaryButton,
  AdminSection,
  AdminSelect,
  AdminTextInput,
} from "@/app/admin/components/admin-controls"
import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { MAX_PRESET_NAME_LENGTH, type LabelPreset } from "@/lib/labels/history"
import { computeA4Grid, suggestThermalColumns, thermalRowWidth } from "@/lib/labels/layout"
import {
  LABEL_DPI_OPTIONS,
  LABEL_FORMAT_PRESETS,
  LABEL_LIMITS,
  THERMAL_COLUMN_OPTIONS,
  applyFormatPreset,
  dpiForMode,
  formatMm,
  matchFormatPreset,
  measureError,
  type LabelFormatPreset,
  type LabelOutputMode,
  type LabelSettings,
} from "@/lib/labels/settings"
import { cn } from "@/lib/utils"

import { LabelFormatDiagram } from "./label-format-diagram"

type Limit = { min: number; max: number }
export type SettingsChange = (change: (current: LabelSettings) => LabelSettings) => void

const mm = (value: number) => formatMm(value).replace(" mm", "")

function FieldLabel({ children, help, helpLabel }: { children: ReactNode; help?: string; helpLabel?: string }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-xs font-bold text-white/78">
      {children}
      {help && <AdminHelpTip label={helpLabel ?? String(children)} text={help} />}
    </span>
  )
}

// Medida en mm: se edita como texto y sólo se aplica cuando es válida; al
// salir del campo vuelve al último valor válido.
function MeasureField({ label, value, limit, help, onCommit, suffix = "mm" }: {
  label: string
  value: number
  limit: Limit
  help?: string
  suffix?: string
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const error = draft === null ? null : measureError(draft, limit, label)
  return (
    <div className="min-w-0" onBlur={() => setDraft(null)}>
      <FieldLabel help={help} helpLabel={label}>{label}</FieldLabel>
      <div className="relative">
        <AdminTextInput
          title={label}
          placeholder={String(limit.min)}
          ariaLabel={`${label} (${suffix})`}
          inputMode="decimal"
          value={draft ?? String(value).replace(".", ",")}
          className={cn("h-10 pr-10", error && "text-red-300")}
          onChange={(next) => {
            const clean = next.replace(/[^\d.,]/g, "").slice(0, 6)
            setDraft(clean)
            if (!measureError(clean, limit, label)) onCommit(Math.round(Number(clean.replace(",", ".")) * 10) / 10)
          }}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-white/50">{suffix}</span>
      </div>
      {error && <p className="mt-1 text-11px font-bold text-red-300">{error}</p>}
    </div>
  )
}

function StepBlock({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <div className="admin-label-block">
      <h3 className="mb-2.5 flex items-center gap-1 text-xs font-black uppercase tracking-wide text-white/78">
        {title}
        {help && <AdminHelpTip label={title} text={help} />}
      </h3>
      {children}
    </div>
  )
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="admin-label-details group">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-bold text-white/78">
        <ChevronRight className="admin-label-details-icon size-3.5 shrink-0 transition-transform" aria-hidden="true" />
        {summary}
      </summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  )
}

const MODES: { mode: LabelOutputMode; title: string; hint: string; icon: ReactNode }[] = [
  { mode: "thermal", title: "Rollo térmico", hint: "Zebra, Xprinter, Honeywell…", icon: <Printer className="size-4" /> },
  { mode: "a4", title: "Hoja A4", hint: "Impresora común, autoadhesivas", icon: <FileText className="size-4" /> },
]

/** "2 columnas · 39 × 20 mm c/u" o "4 × 12 = 48 por hoja". */
export function formatLayoutSummary(settings: LabelSettings) {
  if (settings.mode === "thermal") {
    const { columns } = settings.thermal
    return columns === 1 ? "1 columna" : `${columns} etiquetas de ${mm(settings.widthMm)} × ${mm(settings.heightMm)} mm por fila`
  }
  const grid = computeA4Grid(settings)
  return grid.perPage ? `${grid.columns} col. × ${grid.rows} filas = ${grid.perPage} por hoja` : "No entra en la hoja"
}

/** Nombre corto del formato elegido: "Rollo 80 × 20 · 2 col." */
export function formatName(settings: LabelSettings) {
  if (settings.mode === "thermal") {
    const columns = settings.thermal.columns
    return `Rollo ${mm(thermalRowWidth(settings))} × ${mm(settings.heightMm)}${columns > 1 ? ` · ${columns} col.` : ""}`
  }
  return `A4 · ${mm(settings.widthMm)} × ${mm(settings.heightMm)}`
}

function PresetCard({ preset, settings, selected, onSelect }: { preset: LabelFormatPreset; settings: LabelSettings; selected: boolean; onSelect: () => void }) {
  const applied = applyFormatPreset(settings, preset)
  return (
    <button type="button" role="radio" aria-checked={selected} className="admin-label-option flex items-center gap-3 p-2.5 text-left" data-selected={selected ? "true" : "false"} onClick={onSelect}>
      <span className="flex h-12 w-14 shrink-0 items-center justify-center">
        <LabelFormatDiagram settings={applied} className="max-h-12 max-w-14" />
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 text-sm font-black text-white">
          {preset.name}
          {preset.recommended && <span className="admin-label-chip">Recomendado</span>}
        </span>
        <span className="mt-0.5 block text-xs text-white/62">{formatLayoutSummary(applied)}</span>
      </span>
    </button>
  )
}

export function LabelSettingsPanel({ settings, onChange, presets, storageUnavailable, preferenceError, onSavePreset, onDeletePreset, className }: {
  settings: LabelSettings
  onChange: SettingsChange
  presets: LabelPreset[]
  storageUnavailable: boolean
  preferenceError: string
  onSavePreset: (name: string, overwrite: boolean) => Promise<"saved" | "exists">
  onDeletePreset: (preset: LabelPreset) => Promise<void>
  className?: string
}) {
  const [presetName, setPresetName] = useState("")
  const [presetBusy, setPresetBusy] = useState(false)
  const [presetMessage, setPresetMessage] = useState("")
  const [overwriteName, setOverwriteName] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LabelPreset | null>(null)
  const matched = matchFormatPreset(settings)
  const thermal = settings.mode === "thermal"
  const suggestion = suggestThermalColumns(settings)
  const set = (patch: Partial<LabelSettings>) => onChange((current) => ({ ...current, ...patch }))
  const setA4 = (patch: Partial<LabelSettings["a4"]>) => onChange((current) => ({ ...current, a4: { ...current.a4, ...patch } }))
  const setThermal = (patch: Partial<LabelSettings["thermal"]>) => onChange((current) => ({ ...current, thermal: { ...current.thermal, ...patch } }))

  async function savePreset(name: string, overwrite: boolean) {
    if (presetBusy) return
    setPresetBusy(true)
    setPresetMessage("")
    try {
      const result = await onSavePreset(name, overwrite)
      if (result === "exists") { setOverwriteName(name); return }
      setPresetName("")
      setOverwriteName(null)
      setPresetMessage(`Formato "${name}" guardado.`)
    } catch (cause) {
      setPresetMessage(cause instanceof Error ? cause.message : "No se pudo guardar el formato.")
    } finally {
      setPresetBusy(false)
    }
  }

  return (
    <AdminSection compact icon={<Ruler className="size-4" />} title="Formato de etiqueta" description="Elegí dónde imprimís y el tamaño. Se recuerda para la próxima vez." className={className}>
      <div className="space-y-5">
        <StepBlock title="Impresora">
          <div role="radiogroup" aria-label="Tipo de impresión" className="grid gap-2 sm:grid-cols-2">
            {MODES.map((option) => (
              <button
                key={option.mode}
                type="button"
                role="radio"
                aria-checked={settings.mode === option.mode}
                className="admin-label-option flex items-center gap-3 p-3 text-left"
                data-selected={settings.mode === option.mode ? "true" : "false"}
                onClick={() => set({ mode: option.mode, dpi: dpiForMode(option.mode, settings.dpi) })}
              >
                <span className="admin-label-option-icon flex size-8 shrink-0 items-center justify-center">{option.icon}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-black text-white">{option.title}</span>
                  <span className="block text-xs text-white/62">{option.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </StepBlock>

        <StepBlock title="Formato" help={thermal ? "Las columnas son las etiquetas que hay lado a lado en cada fila del rollo." : "En A4 las columnas y filas se calculan solas según el tamaño y los márgenes."}>
          <div role="radiogroup" aria-label="Formato de etiqueta" className="grid gap-2 sm:grid-cols-2">
            {LABEL_FORMAT_PRESETS.filter((preset) => preset.mode === settings.mode).map((preset) => (
              <PresetCard key={preset.id} preset={preset} settings={settings} selected={matched?.id === preset.id} onSelect={() => onChange((current) => applyFormatPreset(current, preset))} />
            ))}
            <div className="admin-label-option flex items-center gap-3 p-2.5" data-selected={matched ? "false" : "true"} data-static="true">
              <span className="admin-label-option-icon flex h-12 w-14 shrink-0 items-center justify-center"><PencilRuler className="size-5" aria-hidden="true" /></span>
              <span className="min-w-0">
                <span className="block text-sm font-black text-white">Personalizado</span>
                <span className="mt-0.5 block text-xs text-white/62">{matched ? "Escribí tus medidas abajo" : formatLayoutSummary(settings)}</span>
              </span>
            </div>
          </div>
        </StepBlock>

        <StepBlock title="Medidas">
          {thermal ? (
            <div className="space-y-3">
              <div>
                <FieldLabel help="Etiquetas lado a lado en cada fila del rollo. Un rollo de 80 mm con dos etiquetas = 2 columnas. Medí siempre UNA etiqueta, no el rollo completo.">Columnas del rollo</FieldLabel>
                <div role="radiogroup" aria-label="Columnas del rollo" className="admin-label-segmented inline-flex">
                  {THERMAL_COLUMN_OPTIONS.map((columns) => (
                    <button key={columns} type="button" role="radio" aria-checked={settings.thermal.columns === columns} data-selected={settings.thermal.columns === columns ? "true" : "false"} className="admin-label-segment px-4 py-1.5 text-sm font-black" onClick={() => setThermal({ columns })}>
                      {columns}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MeasureField label={settings.thermal.columns > 1 ? "Ancho de cada etiqueta" : "Ancho"} value={settings.widthMm} limit={LABEL_LIMITS.widthMm} onCommit={(widthMm) => set({ widthMm })} />
                <MeasureField label="Alto" value={settings.heightMm} limit={LABEL_LIMITS.heightMm} onCommit={(heightMm) => set({ heightMm })} />
                {settings.thermal.columns > 1 && (
                  <MeasureField label="Separación entre columnas" value={settings.thermal.columnGapMm} limit={LABEL_LIMITS.thermalColumnGapMm} onCommit={(columnGapMm) => setThermal({ columnGapMm })} help="Espacio sin etiqueta entre una columna y la otra. Medilo en tu rollo; suele ser 2 mm." />
                )}
                <MeasureField label="Separación entre filas" value={settings.thermal.gapMm} limit={LABEL_LIMITS.thermalGapMm} onCommit={(gapMm) => setThermal({ gapMm })} help="Espacio entre una fila y la siguiente. La impresora lo detecta sola; se usa para el largo de rollo y el ZPL." />
                <MeasureField label="Borde del rollo" value={settings.thermal.sideMarginMm} limit={LABEL_LIMITS.thermalSideMarginMm} onCommit={(sideMarginMm) => setThermal({ sideMarginMm })} help="Papel soporte libre a cada lado de la fila, antes de la primera etiqueta y después de la última. Suele ser 0." />
              </div>
              {suggestion && (
                <div className="admin-label-status flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs" data-tone="info" data-column-suggestion>
                  <span>¿Es un rollo de {suggestion.columns} etiquetas por fila? Medí <strong>una</strong> etiqueta: serían {suggestion.columns} de {mm(suggestion.widthMm)} × {mm(settings.heightMm)} mm.</span>
                  <AdminButton size="sm" onClick={() => onChange((current) => ({ ...current, widthMm: suggestion.widthMm, thermal: { ...current.thermal, columns: suggestion.columns } }))}>
                    Usar {suggestion.columns} columnas
                  </AdminButton>
                </div>
              )}
              <p className="admin-label-callout px-3 py-2 text-xs text-white/72" data-roll-summary>
                Cada fila del rollo mide <strong className="text-white">{mm(thermalRowWidth(settings))} × {mm(settings.heightMm)} mm</strong>
                {settings.thermal.columns > 1 ? <> y lleva <strong className="text-white">{settings.thermal.columns} etiquetas</strong> de {mm(settings.widthMm)} × {mm(settings.heightMm)} mm.</> : "."}
              </p>
              <div className="max-w-48">
                <FieldLabel help="Densidad de la impresora: figura en su ficha (203 o 300 dpi). Las barras se ajustan a puntos enteros para salir nítidas." helpLabel="Resolución">Resolución</FieldLabel>
                <AdminSelect title="Resolución" value={String(settings.dpi)} onChange={(value) => set({ dpi: Number(value) as LabelSettings["dpi"] })}>
                  {LABEL_DPI_OPTIONS.map((dpi) => <option key={dpi} value={String(dpi)}>{`${dpi} dpi`}</option>)}
                </AdminSelect>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <MeasureField label="Ancho" value={settings.widthMm} limit={LABEL_LIMITS.widthMm} onCommit={(widthMm) => set({ widthMm })} />
                <MeasureField label="Alto" value={settings.heightMm} limit={LABEL_LIMITS.heightMm} onCommit={(heightMm) => set({ heightMm })} />
                <div className="min-w-0">
                  <FieldLabel>Orientación de la hoja</FieldLabel>
                  <AdminSelect title="Orientación" value={settings.a4.orientation} onChange={(value) => setA4({ orientation: value === "landscape" ? "landscape" : "portrait" })}>
                    <option value="portrait">Vertical</option>
                    <option value="landscape">Horizontal</option>
                  </AdminSelect>
                </div>
                <label className="flex cursor-pointer items-center gap-2 self-end pb-2.5 text-sm font-bold text-white/80">
                  <input type="checkbox" className="size-4 accent-blue-500" checked={settings.a4.cutMarks} onChange={(event) => setA4({ cutMarks: event.target.checked })} />
                  Líneas de corte
                </label>
              </div>
              <Disclosure summary="Márgenes y separación de la hoja">
                <div className="grid grid-cols-2 gap-3">
                  <MeasureField label="Margen superior" value={settings.a4.marginTopMm} limit={LABEL_LIMITS.marginTopMm} onCommit={(marginTopMm) => setA4({ marginTopMm })} help="Del borde superior (y del inferior) a la primera fila. Muchas impresoras no imprimen a menos de 4–5 mm del borde." />
                  <MeasureField label="Margen lateral" value={settings.a4.marginSideMm} limit={LABEL_LIMITS.marginSideMm} onCommit={(marginSideMm) => setA4({ marginSideMm })} help="De los bordes izquierdo y derecho a las etiquetas. Si la hoja es precortada, usá su medida." />
                  <MeasureField label="Separación horizontal" value={settings.a4.gapXMm} limit={LABEL_LIMITS.gapXMm} onCommit={(gapXMm) => setA4({ gapXMm })} />
                  <MeasureField label="Separación vertical" value={settings.a4.gapYMm} limit={LABEL_LIMITS.gapYMm} onCommit={(gapYMm) => setA4({ gapYMm })} />
                </div>
              </Disclosure>
            </div>
          )}
        </StepBlock>

        <StepBlock title="Contenido impreso" help="Formato fijo para todas las etiquetas. Si no entra todo en etiquetas muy chicas, se avisa en la vista previa.">
          <ol className="admin-label-callout space-y-0.5 px-3 py-2 text-xs text-white/72" data-label-content>
            <li><strong className="text-white">Nombre del producto</strong></li>
            <li>Color · SKU</li>
            <li>Código de barras</li>
            <li>Número del código</li>
          </ol>
        </StepBlock>

        <div className="space-y-3 border-t border-white/10 pt-4">
          <Disclosure summary="Ajustes avanzados">
            <div className="grid grid-cols-2 gap-3">
              <MeasureField label="Margen interno" value={settings.paddingMm} limit={LABEL_LIMITS.paddingMm} onCommit={(paddingMm) => set({ paddingMm })} help="Espacio libre dentro de cada etiqueta: el texto y las barras nunca lo invaden." />
              <div className="min-w-0">
                <FieldLabel>Tamaño de letra</FieldLabel>
                <AdminSelect title="Tamaño de letra" value={settings.typography} onChange={(value) => set({ typography: value === "compacta" ? "compacta" : value === "grande" ? "grande" : "normal" })}>
                  <option value="compacta">Compacta</option>
                  <option value="normal">Normal</option>
                  <option value="grande">Grande</option>
                </AdminSelect>
              </div>
              <div className="min-w-0">
                <FieldLabel help="Orden de la tanda: el que armaste. Agrupar por producto junta sus variantes; por variante, además las ordena alfabéticamente." helpLabel="Orden de impresión">Orden de impresión</FieldLabel>
                <AdminSelect title="Orden de impresión" value={settings.order} onChange={(value) => set({ order: value === "product" ? "product" : value === "variant" ? "variant" : "manual" })}>
                  <option value="manual">Orden de la tanda</option>
                  <option value="product">Agrupar por producto</option>
                  <option value="variant">Agrupar por variante</option>
                </AdminSelect>
              </div>
              <MeasureField label="Tope por artículo" suffix="u." value={settings.maxCopiesPerItem} limit={LABEL_LIMITS.maxCopiesPerItem} onCommit={(value) => set({ maxCopiesPerItem: Math.round(value) })} help="Máximo de etiquetas por artículo, para evitar errores de tipeo (p. ej. 500 en vez de 5)." />
              {thermal && (
                <label className="col-span-2 flex cursor-pointer items-center gap-2 text-sm font-bold text-white/80">
                  <input type="checkbox" className="size-4 accent-blue-500" checked={settings.thermal.rotate} onChange={(event) => setThermal({ rotate: event.target.checked })} />
                  Girar la etiqueta 90° (rollos que alimentan de costado)
                </label>
              )}
            </div>
          </Disclosure>

          <Disclosure summary={`Formatos guardados${presets.length ? ` (${presets.length})` : ""}`}>
            {storageUnavailable ? (
              <p className="text-xs text-amber-300">Los formatos guardados requieren aplicar la migración de etiquetas. Mientras tanto, el formato se recuerda en este navegador.</p>
            ) : (
              <>
                {presets.length > 0 ? (
                  <ul className="divide-y divide-white/8">
                    {presets.map((preset) => (
                      <li key={preset.id} className="flex items-center justify-between gap-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-white">{preset.name}</p>
                          <p className="text-xs text-white/58">{formatName(preset.settings)} · {formatLayoutSummary(preset.settings)}</p>
                        </div>
                        <AdminButton size="sm" onClick={() => onChange(() => preset.settings)}>Usar</AdminButton>
                        <AdminButton size="icon" aria-label={`Eliminar formato ${preset.name}`} onClick={() => setDeleteTarget(preset)}><Trash2 className="size-3.5" /></AdminButton>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-white/62">Guardá el formato actual con un nombre para reutilizarlo. Lo ven todos los administradores.</p>
                )}
                <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); const name = presetName.trim(); if (name) void savePreset(name, false) }}>
                  <div className="min-w-0 flex-1">
                    <AdminTextInput title="Nombre del formato" placeholder="Ej.: Zebra depósito" maxLength={MAX_PRESET_NAME_LENGTH} value={presetName} onChange={setPresetName} className="h-10" />
                  </div>
                  <AdminPrimaryButton type="submit" icon={<Save className="size-4" />} disabled={presetBusy || !presetName.trim()}>Guardar</AdminPrimaryButton>
                </form>
                {presetMessage && <p role="status" className="text-xs font-bold text-white/72">{presetMessage}</p>}
              </>
            )}
          </Disclosure>
          {preferenceError && <p role="alert" className="text-xs font-bold text-amber-300">{preferenceError}</p>}
        </div>
      </div>

      <AdminModal
        open={overwriteName !== null}
        compact
        title="Reemplazar formato"
        description={`Ya existe un formato llamado "${overwriteName ?? ""}". ¿Reemplazarlo con el actual?`}
        onClose={() => setOverwriteName(null)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setOverwriteName(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={presetBusy} onClick={() => overwriteName && void savePreset(overwriteName, true)}>Reemplazar</AdminPrimaryButton></div>}
      >
        <span />
      </AdminModal>
      <AdminModal
        open={deleteTarget !== null}
        compact
        title="Eliminar formato"
        description={`Se elimina "${deleteTarget?.name ?? ""}" para todos los administradores.`}
        onClose={() => setDeleteTarget(null)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setDeleteTarget(null)}>Cancelar</AdminButton><AdminDangerButton disabled={presetBusy} onClick={() => {
          const target = deleteTarget
          if (!target) return
          setPresetBusy(true)
          onDeletePreset(target)
            .then(() => { setDeleteTarget(null); setPresetMessage(`Formato "${target.name}" eliminado.`) })
            .catch((cause: unknown) => setPresetMessage(cause instanceof Error ? cause.message : "No se pudo eliminar el formato."))
            .finally(() => setPresetBusy(false))
        }}>Eliminar</AdminDangerButton></div>}
      >
        <span />
      </AdminModal>
    </AdminSection>
  )
}
