"use client"

import { useState, type ReactNode } from "react"
import { ChevronDown, Save, SlidersHorizontal, Trash2 } from "lucide-react"

import {
  AdminBadge,
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
import {
  LABEL_DPI_OPTIONS,
  LABEL_LIMITS,
  LABEL_SIZE_PRESETS,
  formatMm,
  matchSizePreset,
  measureError,
  type LabelContentOptions,
  type LabelSettings,
} from "@/lib/labels/settings"
import { cn } from "@/lib/utils"

type Limit = { min: number; max: number }
export type SettingsChange = (change: (current: LabelSettings) => LabelSettings) => void

function FieldLabel({ children, help, helpLabel }: { children: ReactNode; help?: string; helpLabel?: string }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-xs font-black text-white/80">
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
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-white/45">{suffix}</span>
      </div>
      {error && <p className="mt-1 text-11px font-bold text-red-300">{error}</p>}
    </div>
  )
}

function Choice({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <AdminButton size="sm" variant={active ? "primary" : "secondary"} aria-pressed={active} aria-label={label} onClick={onClick}>
      {children}
    </AdminButton>
  )
}

function Group({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-t border-white/10 pt-3 first:border-t-0 first:pt-0">
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left text-11px font-black uppercase tracking-widest text-beyonix-cyan" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {title}
        <ChevronDown className={cn("size-4 transition", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}

const CONTENT_OPTIONS: { key: keyof LabelContentOptions; label: string }[] = [
  { key: "name", label: "Nombre corto" },
  { key: "variant", label: "Variante / color" },
  { key: "barcodeText", label: "Número legible" },
  { key: "sku", label: "SKU" },
  { key: "price", label: "Precio" },
  { key: "internalCode", label: "Código interno" },
]

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
  const sizePreset = matchSizePreset(settings)
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
      setPresetMessage(`Preset "${name}" guardado.`)
    } catch (cause) {
      setPresetMessage(cause instanceof Error ? cause.message : "No se pudo guardar el preset.")
    } finally {
      setPresetBusy(false)
    }
  }

  return (
    <AdminSection compact icon={<SlidersHorizontal className="size-4" />} title="Configuración" className={className}>
      <div className="space-y-3">
        <Group title="Salida y tamaño">
          <div>
            <FieldLabel help="Hoja A4: impresora común (láser o chorro de tinta), varias etiquetas por hoja. Térmica: rollo de etiquetas (Zebra, Honeywell…), una etiqueta por página." helpLabel="Tipo de salida">Tipo</FieldLabel>
            <div className="flex flex-wrap gap-2">
              <Choice active={settings.mode === "a4"} onClick={() => set({ mode: "a4", dpi: 600 })}>Hoja A4</Choice>
              <Choice active={settings.mode === "thermal"} onClick={() => set({ mode: "thermal", dpi: settings.dpi === 600 ? 203 : settings.dpi })}>Térmica</Choice>
            </div>
          </div>
          <div>
            <FieldLabel help="Tamaños de partida. Personalizada: escribí el ancho y el alto de tu etiqueta en milímetros." helpLabel="Tamaño de etiqueta">Tamaño</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {LABEL_SIZE_PRESETS.map((preset) => (
                <Choice key={preset.id} active={sizePreset?.id === preset.id} label={`${preset.name} ${preset.widthMm} × ${preset.heightMm} mm`} onClick={() => set({ widthMm: preset.widthMm, heightMm: preset.heightMm })}>
                  {preset.name} <span className="font-bold opacity-75">{preset.widthMm}×{preset.heightMm}</span>
                </Choice>
              ))}
              {!sizePreset && <AdminBadge tone="info" className="self-center">Personalizada</AdminBadge>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MeasureField label="Ancho" value={settings.widthMm} limit={LABEL_LIMITS.widthMm} onCommit={(widthMm) => set({ widthMm })} help="Ancho físico de la etiqueta. En térmica es el ancho del rollo." />
            <MeasureField label="Alto" value={settings.heightMm} limit={LABEL_LIMITS.heightMm} onCommit={(heightMm) => set({ heightMm })} help="Alto físico de la etiqueta (largo en el sentido del rollo)." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <MeasureField label="Margen interno" value={settings.paddingMm} limit={LABEL_LIMITS.paddingMm} onCommit={(paddingMm) => set({ paddingMm })} help="Espacio libre dentro de cada etiqueta: el texto y las barras nunca lo invaden." />
            <div className="min-w-0">
              <FieldLabel help="Densidad de la impresora. Térmicas: 203 o 300 dpi (figura en la ficha del equipo). A4 láser/chorro de tinta: 600. Las barras se ajustan a puntos enteros para que salgan nítidas." helpLabel="DPI">DPI</FieldLabel>
              <AdminSelect title="DPI" value={String(settings.dpi)} onChange={(value) => set({ dpi: Number(value) as LabelSettings["dpi"] })}>
                {LABEL_DPI_OPTIONS.map((dpi) => <option key={dpi} value={String(dpi)}>{`${dpi} dpi`}</option>)}
              </AdminSelect>
            </div>
          </div>
        </Group>

        {settings.mode === "a4" ? (
          <Group title="Hoja A4">
            <div className="grid grid-cols-2 gap-3">
              <div className="min-w-0">
                <FieldLabel>Orientación</FieldLabel>
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
            <div className="grid grid-cols-2 gap-3">
              <MeasureField label="Margen superior" value={settings.a4.marginTopMm} limit={LABEL_LIMITS.marginTopMm} onCommit={(marginTopMm) => setA4({ marginTopMm })} help="Distancia del borde superior (y del inferior) de la hoja a la primera fila. Muchas impresoras domésticas no imprimen a menos de 4–5 mm del borde." />
              <MeasureField label="Margen lateral" value={settings.a4.marginSideMm} limit={LABEL_LIMITS.marginSideMm} onCommit={(marginSideMm) => setA4({ marginSideMm })} help="Distancia de los bordes izquierdo y derecho a las etiquetas. Usá la medida de tu hoja autoadhesiva si es precortada." />
              <MeasureField label="Separación horizontal" value={settings.a4.gapXMm} limit={LABEL_LIMITS.gapXMm} onCommit={(gapXMm) => setA4({ gapXMm })} help="Espacio entre columnas de etiquetas." />
              <MeasureField label="Separación vertical" value={settings.a4.gapYMm} limit={LABEL_LIMITS.gapYMm} onCommit={(gapYMm) => setA4({ gapYMm })} help="Espacio entre filas de etiquetas." />
            </div>
          </Group>
        ) : (
          <Group title="Impresora térmica">
            <div className="grid grid-cols-2 gap-3">
              <MeasureField label="Gap" value={settings.thermal.gapMm} limit={LABEL_LIMITS.thermalGapMm} onCommit={(gapMm) => setThermal({ gapMm })} help="Separación entre etiquetas del rollo (el espacio sin adhesivo). La impresora lo detecta sola; se usa para calcular el largo de rollo y el ZPL." />
              <label className="flex cursor-pointer items-center gap-2 self-end pb-2.5 text-sm font-bold text-white/80">
                <input type="checkbox" className="size-4 accent-blue-500" checked={settings.thermal.rotate} onChange={(event) => setThermal({ rotate: event.target.checked })} />
                Girar 90°
              </label>
            </div>
            <p className="text-xs text-white/55">En el diálogo de impresión elegí el tamaño de papel de la etiqueta, escala 100 % y sin márgenes.</p>
          </Group>
        )}

        <Group title="Contenido">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {CONTENT_OPTIONS.map((option) => (
              <label key={option.key} className="flex cursor-pointer items-center gap-2 text-sm font-bold text-white/80">
                <input
                  type="checkbox"
                  className="size-4 accent-blue-500"
                  checked={settings.content[option.key]}
                  onChange={(event) => onChange((current) => ({ ...current, content: { ...current.content, [option.key]: event.target.checked } }))}
                />
                {option.label}
              </label>
            ))}
          </div>
          {settings.content.price && <p className="text-xs text-amber-300">El precio queda impreso: si cambia, hay que reimprimir.</p>}
        </Group>

        <Group title="Avanzado" defaultOpen={false}>
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <FieldLabel>Tipografía</FieldLabel>
              <AdminSelect title="Tipografía" value={settings.typography} onChange={(value) => set({ typography: value === "compacta" ? "compacta" : value === "grande" ? "grande" : "normal" })}>
                <option value="compacta">Compacta</option>
                <option value="normal">Normal</option>
                <option value="grande">Grande</option>
              </AdminSelect>
            </div>
            <div className="min-w-0">
              <FieldLabel help="Manual: el orden de la cola. Agrupar por producto junta las variantes de cada producto; por variante, además las ordena alfabéticamente." helpLabel="Orden de impresión">Orden</FieldLabel>
              <AdminSelect title="Orden de impresión" value={settings.order} onChange={(value) => set({ order: value === "product" ? "product" : value === "variant" ? "variant" : "manual" })}>
                <option value="manual">Orden de la cola</option>
                <option value="product">Agrupar por producto</option>
                <option value="variant">Agrupar por variante</option>
              </AdminSelect>
            </div>
          </div>
          <MeasureField label="Copias máximas por artículo" suffix="u." value={settings.maxCopiesPerItem} limit={LABEL_LIMITS.maxCopiesPerItem} onCommit={(value) => set({ maxCopiesPerItem: Math.round(value) })} help="Tope de etiquetas por fila de la cola, para evitar errores de tipeo (p. ej. 500 en vez de 5)." />
        </Group>

        <Group title="Presets">
          {storageUnavailable ? (
            <p className="text-xs text-amber-300">Los presets y el historial requieren aplicar la migración de etiquetas. La configuración se recuerda en este navegador.</p>
          ) : (
            <>
              {presets.length > 0 ? (
                <ul className="space-y-1.5">
                  {presets.map((preset) => (
                    <li key={preset.id} className="flex items-center justify-between gap-2">
                      <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-bold text-white hover:text-beyonix-sky" title={`Aplicar ${preset.name}`} onClick={() => onChange(() => preset.settings)}>
                        {preset.name}
                        <span className="ml-2 text-xs font-medium text-white/50">
                          {formatMm(preset.settings.widthMm).replace(" mm", "")} × {formatMm(preset.settings.heightMm)} · {preset.settings.mode === "a4" ? "A4" : `Térmica ${preset.settings.dpi} dpi`}
                        </span>
                      </button>
                      <AdminButton size="sm" onClick={() => onChange(() => preset.settings)}>Aplicar</AdminButton>
                      <AdminButton size="icon" aria-label={`Eliminar preset ${preset.name}`} onClick={() => setDeleteTarget(preset)}><Trash2 className="size-3.5" /></AdminButton>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-white/55">Guardá la configuración actual (tamaño, salida, márgenes, DPI y contenido) para reutilizarla. Ej.: “Zebra estándar”.</p>
              )}
              <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); const name = presetName.trim(); if (name) void savePreset(name, false) }}>
                <div className="min-w-0 flex-1">
                  <FieldLabel help="Los presets son compartidos entre los administradores." helpLabel="Presets">Nombre del preset</FieldLabel>
                  <AdminTextInput title="Nombre del preset" placeholder="Etiqueta chica productos" maxLength={MAX_PRESET_NAME_LENGTH} value={presetName} onChange={setPresetName} />
                </div>
                <AdminPrimaryButton type="submit" icon={<Save className="size-4" />} disabled={presetBusy || !presetName.trim()}>Guardar</AdminPrimaryButton>
              </form>
              {presetMessage && <p role="status" className="text-xs font-bold text-white/70">{presetMessage}</p>}
            </>
          )}
          {preferenceError && <p role="alert" className="text-xs font-bold text-amber-300">{preferenceError}</p>}
        </Group>
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
    </AdminSection>
  )
}
