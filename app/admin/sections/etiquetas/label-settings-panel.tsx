"use client"

import { useState, type ReactNode } from "react"
import { Check, ChevronDown, FileText, Lightbulb, Printer, Save, Trash2 } from "lucide-react"

import {
  AdminBadge,
  AdminButton,
  AdminDangerButton,
  AdminModal,
  AdminPrimaryButton,
  AdminSelect,
  AdminTextInput,
} from "@/app/admin/components/admin-controls"
import { MAX_PRESET_NAME_LENGTH, type LabelPreset } from "@/lib/labels/history"
import { suggestThermalColumns, thermalRowWidth } from "@/lib/labels/layout"
import {
  LABEL_DPI_OPTIONS,
  LABEL_LIMITS,
  LABEL_SIZE_PRESETS,
  THERMAL_COLUMN_OPTIONS,
  THERMAL_ROLL_PRESETS,
  formatMm,
  matchRollPreset,
  matchSizePreset,
  measureError,
  type LabelContentOptions,
  type LabelSettings,
} from "@/lib/labels/settings"
import { cn } from "@/lib/utils"

import { formatNumber } from "./label-preview"
import { FieldLabel, LABEL_STEP_IDS, LabelStepSection } from "./label-ui"

type Limit = { min: number; max: number }
export type SettingsChange = (change: (current: LabelSettings) => LabelSettings) => void

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
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-white/45">{suffix}</span>
      </div>
      {error && <p className="mt-1 text-11px font-bold text-red-300">{error}</p>}
    </div>
  )
}

// Tarjeta seleccionable (botón con aria-pressed).
function OptionCard({ active, onClick, label, title, description, icon, children }: {
  active: boolean
  onClick: () => void
  label?: string
  title: ReactNode
  description?: string
  icon?: ReactNode
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative flex min-w-0 items-start gap-2.5 rounded-xl border p-3 text-left transition",
        active ? "border-beyonix-sky/70 bg-beyonix-blue/20 ring-1 ring-beyonix-sky/40" : "border-white/10 bg-white/3 hover:border-white/25 hover:bg-white/6",
      )}
    >
      {icon && <span className={cn("mt-0.5 shrink-0", active ? "text-beyonix-cyan" : "text-white/55")}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-black leading-tight text-white">{title}</span>
        {description && <span className="mt-1 block text-11px leading-4 text-white/58">{description}</span>}
        {children}
      </span>
      {active && <Check className="size-4 shrink-0 text-beyonix-cyan" aria-hidden="true" />}
    </button>
  )
}

// Rectángulo proporcional para reconocer el tamaño de un vistazo.
function SizeGlyph({ widthMm, heightMm, columns = 1 }: { widthMm: number; heightMm: number; columns?: number }) {
  const gap = 2
  const total = columns * widthMm + (columns - 1) * gap
  const scale = 36 / Math.max(total, heightMm * 1.6)
  return (
    <svg width={38} height={22} viewBox="0 0 38 22" aria-hidden="true" className="shrink-0">
      {Array.from({ length: columns }, (_, column) => (
        <rect
          key={column}
          x={1 + (36 - total * scale) / 2 + column * (widthMm + gap) * scale}
          y={11 - (heightMm * scale) / 2}
          width={widthMm * scale}
          height={heightMm * scale}
          rx={1}
          className="fill-white/15 stroke-current"
          strokeWidth={1}
        />
      ))}
    </svg>
  )
}

function SizeChip({ active, label, name, widthMm, heightMm, columns, detail, onClick }: {
  active: boolean
  label: string
  name: string
  widthMm: number
  heightMm: number
  columns?: number
  detail: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col items-start gap-1.5 rounded-xl border px-2.5 py-2 text-left transition",
        active ? "border-beyonix-sky/70 bg-beyonix-blue/20 text-beyonix-cyan" : "border-white/10 bg-white/3 text-white/50 hover:border-white/25",
      )}
    >
      <SizeGlyph widthMm={widthMm} heightMm={heightMm} columns={columns} />
      <span className="min-w-0">
        <span className="block truncate text-xs font-black text-white">{name}</span>
        <span className="block text-11px font-bold leading-4 text-white/55">{detail}</span>
      </span>
    </button>
  )
}

function Group({ title, summary, children, defaultOpen = false }: { title: string; summary?: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-t border-white/10">
      <button type="button" className="flex w-full items-center justify-between gap-3 py-3 text-left" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span className="min-w-0">
          <span className="block text-sm font-black text-white">{title}</span>
          {summary && !open && <span className="mt-0.5 block truncate text-xs text-white/55">{summary}</span>}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-white/60 transition", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && <div className="space-y-3 pb-4">{children}</div>}
    </div>
  )
}

function CheckOption({ checked, onChange, children, help }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; help?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm font-bold text-white/80" title={help}>
      <input type="checkbox" className="size-4 accent-blue-500" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {children}
    </label>
  )
}

const CONTENT_OPTIONS: { key: keyof LabelContentOptions; label: string }[] = [
  { key: "name", label: "Nombre corto" },
  { key: "variant", label: "Variante / color" },
  { key: "barcodeText", label: "Número bajo las barras" },
  { key: "sku", label: "SKU" },
  { key: "price", label: "Precio" },
  { key: "internalCode", label: "Código interno" },
]

const TYPOGRAPHY_LABELS: Record<LabelSettings["typography"], string> = { compacta: "Compacta", normal: "Normal", grande: "Grande" }
const ORDER_LABELS: Record<LabelSettings["order"], string> = { manual: "Orden de la cola", product: "Agrupar por producto", variant: "Agrupar por variante" }

export function describeFormat(settings: LabelSettings) {
  const size = `${formatNumber(settings.widthMm)} × ${formatNumber(settings.heightMm)} mm`
  if (settings.mode === "a4") return `Hoja A4 · ${size}`
  const columns = settings.thermal.columns
  return `Rollo térmico · ${columns > 1 ? `${columns} por fila de ${size}` : size}`
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
  const thermal = settings.mode === "thermal"
  const columns = thermal ? settings.thermal.columns : 1
  const sizePreset = columns === 1 ? matchSizePreset(settings) : null
  const rollPreset = thermal ? matchRollPreset(settings) : null
  const suggestion = suggestThermalColumns(settings)
  const rowWidth = thermalRowWidth(settings)
  const set = (patch: Partial<LabelSettings>) => onChange((current) => ({ ...current, ...patch }))
  const setA4 = (patch: Partial<LabelSettings["a4"]>) => onChange((current) => ({ ...current, a4: { ...current.a4, ...patch } }))
  const setThermal = (patch: Partial<LabelSettings["thermal"]>) => onChange((current) => ({ ...current, thermal: { ...current.thermal, ...patch } }))
  const enabledContent = CONTENT_OPTIONS.filter((option) => settings.content[option.key]).map((option) => option.label)

  async function savePreset(name: string, overwrite: boolean) {
    if (presetBusy) return
    setPresetBusy(true)
    setPresetMessage("")
    try {
      const result = await onSavePreset(name, overwrite)
      if (result === "exists") { setOverwriteName(name); return }
      setPresetName("")
      setOverwriteName(null)
      setPresetMessage(`Preset "${name}" guardado.`)
    } catch (cause) {
      setPresetMessage(cause instanceof Error ? cause.message : "No se pudo guardar el preset.")
    } finally {
      setPresetBusy(false)
    }
  }

  return (
    <LabelStepSection
      id={LABEL_STEP_IDS.format}
      step={3}
      title="Formato de etiqueta"
      description="Dónde imprimís, el tamaño de cada etiqueta y qué datos lleva."
      className={className}
    >
      <div className="space-y-5">
        <div>
          <FieldLabel help="Hoja A4: impresora común; las etiquetas se acomodan en filas y columnas dentro de la hoja. Rollo térmico: impresora de etiquetas (Zebra, Honeywell, Xprinter…); se imprime fila por fila del rollo." helpLabel="Tipo de impresión">¿Dónde vas a imprimir?</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            <OptionCard
              active={!thermal}
              icon={<FileText className="size-5" />}
              title="Hoja A4"
              description="Impresora láser o de tinta. Varias etiquetas por hoja autoadhesiva."
              onClick={() => set({ mode: "a4", dpi: 600 })}
            />
            <OptionCard
              active={thermal}
              icon={<Printer className="size-5" />}
              title="Rollo térmico"
              description="Impresora de etiquetas. Rollos de 1 o más etiquetas por fila."
              onClick={() => set({ mode: "thermal", dpi: settings.dpi === 600 ? 203 : settings.dpi })}
            />
          </div>
        </div>

        <div>
          <FieldLabel help={thermal ? "Medí UNA etiqueta (no el rollo completo). En un rollo de 10 × 2 cm con 2 etiquetas por fila, cada etiqueta mide unos 4,9 × 2 cm." : "Medí una etiqueta de la hoja. Personalizada: escribí el ancho y el alto en milímetros."} helpLabel="Tamaño de etiqueta">Tamaño de cada etiqueta</FieldLabel>
          <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
            {LABEL_SIZE_PRESETS.map((preset) => (
              <SizeChip
                key={preset.id}
                active={sizePreset?.id === preset.id}
                label={`${preset.name} ${preset.widthMm} × ${preset.heightMm} mm`}
                name={preset.name}
                detail={`${preset.widthMm} × ${preset.heightMm} mm`}
                widthMm={preset.widthMm}
                heightMm={preset.heightMm}
                onClick={() => onChange((current) => ({ ...current, widthMm: preset.widthMm, heightMm: preset.heightMm, thermal: { ...current.thermal, columns: 1 } }))}
              />
            ))}
          </div>
          {thermal && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              {THERMAL_ROLL_PRESETS.map((preset) => (
                <SizeChip
                  key={preset.id}
                  active={rollPreset?.id === preset.id}
                  label={`${preset.name}: ${preset.description}`}
                  name={preset.name}
                  detail={preset.description}
                  widthMm={preset.widthMm}
                  heightMm={preset.heightMm}
                  columns={preset.columns}
                  onClick={() => onChange((current) => ({ ...current, widthMm: preset.widthMm, heightMm: preset.heightMm, thermal: { ...current.thermal, columns: preset.columns, columnGapMm: preset.columnGapMm, rotate: false } }))}
                />
              ))}
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <MeasureField label="Ancho" value={settings.widthMm} limit={LABEL_LIMITS.widthMm} onCommit={(widthMm) => set({ widthMm })} help={thermal ? "Ancho de UNA etiqueta. Si el rollo trae varias por fila, no pongas el ancho total del rollo." : "Ancho físico de la etiqueta."} />
            <MeasureField label="Alto" value={settings.heightMm} limit={LABEL_LIMITS.heightMm} onCommit={(heightMm) => set({ heightMm })} help="Alto físico de la etiqueta (en el rollo, el largo en el sentido en que avanza el papel)." />
          </div>
          {!sizePreset && !rollPreset && <AdminBadge tone="info" className="mt-2">Medida personalizada</AdminBadge>}
        </div>

        {thermal && (
          <div>
            <FieldLabel help="Muchos rollos traen 2 o más etiquetas lado a lado. Ej.: un rollo de 10 × 2 cm suele ser 2 etiquetas de 4,9 × 2 cm. Cada fila se imprime de una vez y se van llenando de izquierda a derecha." helpLabel="Etiquetas por fila">Etiquetas por fila del rollo</FieldLabel>
            <div className="grid grid-cols-4 gap-2" role="group" aria-label="Etiquetas por fila del rollo">
              {THERMAL_COLUMN_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={columns === option}
                  aria-label={`${option} ${option === 1 ? "etiqueta" : "etiquetas"} por fila`}
                  onClick={() => setThermal({ columns: option, ...(option > 1 ? { rotate: false } : {}) })}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-xl border px-2 py-2 transition",
                    columns === option ? "border-beyonix-sky/70 bg-beyonix-blue/20 text-beyonix-cyan" : "border-white/10 bg-white/3 text-white/45 hover:border-white/25",
                  )}
                >
                  <SizeGlyph widthMm={20} heightMm={12} columns={option} />
                  <span className="text-xs font-black text-white">{option}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-white/60">
              Ancho total de la fila: <span className="font-black text-white">{formatMm(rowWidth)}</span>
              {columns > 1 && <> · {columns} × {formatMm(settings.widthMm)} + {columns - 1} {columns - 1 === 1 ? "separación" : "separaciones"} de {formatMm(settings.thermal.columnGapMm)}</>}
            </p>
            {suggestion && (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-amber-400/10 px-3 py-2.5 text-xs text-amber-200">
                <Lightbulb className="size-4 shrink-0" aria-hidden="true" />
                <p className="min-w-0 flex-1 leading-5">
                  ¿Tu rollo de {formatNumber(settings.widthMm / 10)} × {formatNumber(settings.heightMm / 10)} cm trae 2 etiquetas por fila? Hoy se imprime como <strong>una sola etiqueta larga</strong>.
                </p>
                <AdminButton size="sm" onClick={() => onChange((current) => ({ ...current, widthMm: suggestion.widthMm, thermal: { ...current.thermal, columns: suggestion.columns } }))}>
                  Usar 2 de {formatMm(suggestion.widthMm)}
                </AdminButton>
              </div>
            )}
          </div>
        )}

        <div>
          {thermal ? (
            <Group
              title="Rollo: separaciones y giro"
              summary={`Entre filas ${formatMm(settings.thermal.gapMm)}${columns > 1 ? ` · entre columnas ${formatMm(settings.thermal.columnGapMm)}` : ""}${settings.thermal.sideMarginMm ? ` · borde ${formatMm(settings.thermal.sideMarginMm)}` : ""}${settings.thermal.rotate ? " · girada 90°" : ""}`}
            >
              <div className="grid grid-cols-2 gap-3">
                <MeasureField label="Separación entre filas" value={settings.thermal.gapMm} limit={LABEL_LIMITS.thermalGapMm} onCommit={(gapMm) => setThermal({ gapMm })} help="Espacio sin adhesivo entre una fila de etiquetas y la siguiente (gap). La impresora lo detecta sola; se usa para calcular el largo de rollo." />
                {columns > 1 && (
                  <MeasureField label="Separación entre columnas" value={settings.thermal.columnGapMm} limit={LABEL_LIMITS.thermalColumnGapMm} onCommit={(columnGapMm) => setThermal({ columnGapMm })} help="Espacio entre dos etiquetas de la misma fila." />
                )}
                <MeasureField label="Borde del rollo" value={settings.thermal.sideMarginMm} limit={LABEL_LIMITS.thermalSideMarginMm} onCommit={(sideMarginMm) => setThermal({ sideMarginMm })} help="Papel soporte libre a cada lado de la fila, antes de la primera etiqueta y después de la última. Casi siempre 0–2 mm." />
              </div>
              {columns === 1 ? (
                <CheckOption checked={settings.thermal.rotate} onChange={(rotate) => setThermal({ rotate })} help="Para rollos que alimentan de costado: el diseño se gira 90°.">Girar la etiqueta 90°</CheckOption>
              ) : (
                <p className="text-xs text-white/55">El giro de 90° sólo está disponible con 1 etiqueta por fila.</p>
              )}
              <p className="text-xs text-white/55">En el diálogo de impresión elegí un papel de {formatMm(rowWidth)} × {formatMm(settings.heightMm)}, escala 100 % y sin márgenes.</p>
            </Group>
          ) : (
            <Group
              title="Hoja A4: márgenes y separaciones"
              summary={`${settings.a4.orientation === "portrait" ? "Vertical" : "Horizontal"} · márgenes ${formatNumber(settings.a4.marginTopMm)} / ${formatNumber(settings.a4.marginSideMm)} mm · separación ${formatNumber(settings.a4.gapXMm)} / ${formatNumber(settings.a4.gapYMm)} mm`}
            >
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <FieldLabel>Orientación</FieldLabel>
                  <AdminSelect title="Orientación" value={settings.a4.orientation} onChange={(value) => setA4({ orientation: value === "landscape" ? "landscape" : "portrait" })}>
                    <option value="portrait">Vertical</option>
                    <option value="landscape">Horizontal</option>
                  </AdminSelect>
                </div>
                <div className="flex items-end pb-2.5">
                  <CheckOption checked={settings.a4.cutMarks} onChange={(cutMarks) => setA4({ cutMarks })} help="Contorno punteado gris para recortar a mano.">Líneas de corte</CheckOption>
                </div>
                <MeasureField label="Margen superior" value={settings.a4.marginTopMm} limit={LABEL_LIMITS.marginTopMm} onCommit={(marginTopMm) => setA4({ marginTopMm })} help="Distancia del borde superior (y del inferior) de la hoja a la primera fila. Muchas impresoras domésticas no imprimen a menos de 4–5 mm del borde." />
                <MeasureField label="Margen lateral" value={settings.a4.marginSideMm} limit={LABEL_LIMITS.marginSideMm} onCommit={(marginSideMm) => setA4({ marginSideMm })} help="Distancia de los bordes izquierdo y derecho a las etiquetas. Si la hoja es precortada, usá la medida que indica el fabricante." />
                <MeasureField label="Separación horizontal" value={settings.a4.gapXMm} limit={LABEL_LIMITS.gapXMm} onCommit={(gapXMm) => setA4({ gapXMm })} help="Espacio entre columnas de etiquetas." />
                <MeasureField label="Separación vertical" value={settings.a4.gapYMm} limit={LABEL_LIMITS.gapYMm} onCommit={(gapYMm) => setA4({ gapYMm })} help="Espacio entre filas de etiquetas." />
              </div>
            </Group>
          )}

          <Group title="Contenido de la etiqueta" summary={enabledContent.length ? enabledContent.join(", ") : "Sólo barras"}>
            <div className="grid gap-x-3 gap-y-2.5 sm:grid-cols-2">
              {CONTENT_OPTIONS.map((option) => (
                <CheckOption
                  key={option.key}
                  checked={settings.content[option.key]}
                  onChange={(checked) => onChange((current) => ({ ...current, content: { ...current.content, [option.key]: checked } }))}
                >
                  {option.label}
                </CheckOption>
              ))}
            </div>
            {settings.content.price && <p className="text-xs text-amber-300">El precio queda impreso: si cambia, hay que reimprimir.</p>}
          </Group>

          <Group title="Impresora y calidad" summary={`${settings.dpi} dpi · margen interno ${formatMm(settings.paddingMm)} · letra ${TYPOGRAPHY_LABELS[settings.typography].toLowerCase()}`}>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <FieldLabel help="Densidad de la impresora (figura en su ficha). Térmicas: 203 o 300 dpi. A4 láser/tinta: 600. Las barras se ajustan a puntos enteros para que salgan nítidas." helpLabel="Densidad (dpi)">Densidad (dpi)</FieldLabel>
                <AdminSelect title="DPI" value={String(settings.dpi)} onChange={(value) => set({ dpi: Number(value) as LabelSettings["dpi"] })}>
                  {LABEL_DPI_OPTIONS.map((dpi) => <option key={dpi} value={String(dpi)}>{`${dpi} dpi`}</option>)}
                </AdminSelect>
              </div>
              <MeasureField label="Margen interno" value={settings.paddingMm} limit={LABEL_LIMITS.paddingMm} onCommit={(paddingMm) => set({ paddingMm })} help="Espacio libre dentro de cada etiqueta: el texto y las barras nunca lo invaden." />
              <div className="min-w-0">
                <FieldLabel>Tamaño de letra</FieldLabel>
                <AdminSelect title="Tipografía" value={settings.typography} onChange={(value) => set({ typography: value === "compacta" ? "compacta" : value === "grande" ? "grande" : "normal" })}>
                  <option value="compacta">Compacta</option>
                  <option value="normal">Normal</option>
                  <option value="grande">Grande</option>
                </AdminSelect>
              </div>
            </div>
          </Group>

          <Group title="Avanzado" summary={`${ORDER_LABELS[settings.order]} · hasta ${settings.maxCopiesPerItem} por artículo`}>
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <FieldLabel help="Orden de la cola: tal como la ves. Agrupar por producto junta las variantes de cada producto; por variante, además las ordena alfabéticamente." helpLabel="Orden de impresión">Orden de impresión</FieldLabel>
                <AdminSelect title="Orden de impresión" value={settings.order} onChange={(value) => set({ order: value === "product" ? "product" : value === "variant" ? "variant" : "manual" })}>
                  <option value="manual">Orden de la cola</option>
                  <option value="product">Agrupar por producto</option>
                  <option value="variant">Agrupar por variante</option>
                </AdminSelect>
              </div>
              <MeasureField label="Copias máximas por artículo" suffix="u." value={settings.maxCopiesPerItem} limit={LABEL_LIMITS.maxCopiesPerItem} onCommit={(value) => set({ maxCopiesPerItem: Math.round(value) })} help="Tope de etiquetas por artículo de la cola, para evitar errores de tipeo (p. ej. 500 en vez de 5)." />
            </div>
          </Group>

          <Group title="Presets guardados" summary={storageUnavailable ? "No disponibles" : presets.length ? `${presets.length} ${presets.length === 1 ? "preset" : "presets"}` : "Guardá esta configuración para reutilizarla"}>
            {storageUnavailable ? (
              <p className="text-xs text-amber-300">Los presets y el historial requieren aplicar la migración de etiquetas. La configuración se recuerda en este navegador.</p>
            ) : (
              <>
                {presets.length > 0 && (
                  <ul className="divide-y divide-white/8">
                    {presets.map((preset) => (
                      <li key={preset.id} className="flex items-center justify-between gap-2 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-white">{preset.name}</p>
                          <p className="truncate text-xs text-white/50">{describeFormat(preset.settings)}{preset.settings.mode === "thermal" ? ` · ${preset.settings.dpi} dpi` : ""}</p>
                        </div>
                        <AdminButton size="sm" onClick={() => onChange(() => preset.settings)}>Aplicar</AdminButton>
                        <AdminButton size="icon" className="size-8" aria-label={`Eliminar preset ${preset.name}`} onClick={() => setDeleteTarget(preset)}><Trash2 className="size-3.5" /></AdminButton>
                      </li>
                    ))}
                  </ul>
                )}
                <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); const name = presetName.trim(); if (name) void savePreset(name, false) }}>
                  <div className="min-w-0 flex-1">
                    <FieldLabel help="Guarda tamaño, salida, márgenes, DPI y contenido. Los presets son compartidos entre los administradores." helpLabel="Presets">Guardar la configuración actual</FieldLabel>
                    <AdminTextInput title="Nombre del preset" placeholder="Ej.: Zebra rollo doble" maxLength={MAX_PRESET_NAME_LENGTH} value={presetName} onChange={setPresetName} />
                  </div>
                  <AdminPrimaryButton type="submit" icon={<Save className="size-4" />} disabled={presetBusy || !presetName.trim()}>Guardar</AdminPrimaryButton>
                </form>
                {presetMessage && <p role="status" className="text-xs font-bold text-white/70">{presetMessage}</p>}
              </>
            )}
            {preferenceError && <p role="alert" className="text-xs font-bold text-amber-300">{preferenceError}</p>}
          </Group>
        </div>
      </div>

      <AdminModal
        open={overwriteName !== null}
        compact
        title="Reemplazar preset"
        description={`Ya existe un preset llamado "${overwriteName ?? ""}". ¿Reemplazarlo con la configuración actual?`}
        onClose={() => setOverwriteName(null)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setOverwriteName(null)}>Cancelar</AdminButton><AdminPrimaryButton disabled={presetBusy} onClick={() => overwriteName && void savePreset(overwriteName, true)}>Reemplazar</AdminPrimaryButton></div>}
      >
        <span />
      </AdminModal>
      <AdminModal
        open={deleteTarget !== null}
        compact
        title="Eliminar preset"
        description={`Se elimina "${deleteTarget?.name ?? ""}" para todos los administradores.`}
        onClose={() => setDeleteTarget(null)}
        footer={<div className="flex justify-end gap-2"><AdminButton onClick={() => setDeleteTarget(null)}>Cancelar</AdminButton><AdminDangerButton disabled={presetBusy} onClick={() => {
          const target = deleteTarget
          if (!target) return
          setPresetBusy(true)
          onDeletePreset(target)
            .then(() => { setDeleteTarget(null); setPresetMessage(`Preset "${target.name}" eliminado.`) })
            .catch((cause: unknown) => setPresetMessage(cause instanceof Error ? cause.message : "No se pudo eliminar el preset."))
            .finally(() => setPresetBusy(false))
        }}>Eliminar</AdminDangerButton></div>}
      >
        <span />
      </AdminModal>
    </LabelStepSection>
  )
}
