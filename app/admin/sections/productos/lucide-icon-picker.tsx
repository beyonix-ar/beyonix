"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CircleHelp, Pencil, RotateCcw, Search, X } from "lucide-react"
import {
  findSpecIconLabelConflict,
  getSpecIcon,
  getSpecIconDisplayLabel,
  matchesSpecIconSearch,
  normalizeSpecIconLabel,
  SPEC_ICON_CATALOG,
} from "@/lib/products/spec-icons"
import {
  resetSpecIconAlias,
  saveSpecIconAlias,
  type SpecIconAliases,
} from "@/lib/supabase/queries/spec-icon-aliases"

interface LucideIconPickerProps {
  value: string
  onChange: (iconName: string) => void
  /** Nombres visibles personalizados (sólo Admin), por iconName. */
  aliases: SpecIconAliases
  onAliasesChange: (aliases: SpecIconAliases) => void
}

const MIN_POPOVER_WIDTH = 300

/**
 * Selector de ícono. Cada entrada es un ícono distinto (iconName único); el
 * nombre que muestra es el displayLabel (alias ?? nombre base) y sólo ayuda a
 * elegir: la especificación guarda el iconName y su propio texto.
 */
export function LucideIconPicker({
  value,
  onChange,
  aliases,
  onAliasesChange,
}: LucideIconPickerProps) {
  const [search, setSearch] = useState("")
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: MIN_POPOVER_WIDTH })
  const [editingIcon, setEditingIcon] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState("")
  const [savingAlias, setSavingAlias] = useState(false)
  const [aliasError, setAliasError] = useState("")
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const SelectedIcon = value ? getSpecIcon(value) ?? CircleHelp : Search
  const selectedLabel = value ? getSpecIconDisplayLabel(value, aliases) : "Elegir ícono"

  const filteredOptions = useMemo(
    () => SPEC_ICON_CATALOG.filter((option) => matchesSpecIconSearch(option, search, aliases)),
    [search, aliases],
  )

  const saveAlias = async () => {
    if (!editingIcon || savingAlias) return
    const iconName = editingIcon
    const label = draftLabel.trim().replace(/\s+/g, " ")
    if (!label) {
      setAliasError("Escribí un nombre visible.")
      return
    }
    const conflict = findSpecIconLabelConflict(iconName, label, aliases)
    if (conflict) {
      setAliasError(`Ya existe un ícono llamado "${conflict}". Usá un nombre más específico.`)
      return
    }
    // Volver a escribir el nombre base equivale a restablecerlo.
    const isDefault = normalizeSpecIconLabel(label) === normalizeSpecIconLabel(getSpecIconDisplayLabel(iconName, {}))
    setSavingAlias(true)
    setAliasError("")
    try {
      const next = { ...aliases }
      if (isDefault) {
        await resetSpecIconAlias(iconName)
        delete next[iconName]
      } else {
        await saveSpecIconAlias(iconName, label)
        next[iconName] = label
      }
      onAliasesChange(next)
      setEditingIcon(null)
    } catch {
      setAliasError("No se pudo guardar el nombre visible.")
    } finally {
      setSavingAlias(false)
    }
  }

  const resetAlias = async () => {
    if (!editingIcon || savingAlias) return
    const iconName = editingIcon
    setSavingAlias(true)
    setAliasError("")
    try {
      await resetSpecIconAlias(iconName)
      const next = { ...aliases }
      delete next[iconName]
      onAliasesChange(next)
      setEditingIcon(null)
    } catch {
      setAliasError("No se pudo restablecer el nombre.")
    } finally {
      setSavingAlias(false)
    }
  }

  useEffect(() => {
    setMounted(true)
  }, [])

  // Cierra al hacer clic afuera (trigger + menú portaleado cuentan como
  // "adentro") o al presionar Escape. Listeners sólo existen mientras el
  // menú está abierto -- se dan de baja en el cleanup de este mismo efecto,
  // nunca se acumulan entre aperturas.
  useEffect(() => {
    if (!open) return

    function handlePointerDownOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }

    document.addEventListener("mousedown", handlePointerDownOutside)
    document.addEventListener("keydown", handleEscape)

    return () => {
      document.removeEventListener("mousedown", handlePointerDownOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open])

  // Al cerrar se descarta cualquier edición de nombre a medio hacer.
  useEffect(() => {
    if (open) return
    setEditingIcon(null)
    setAliasError("")
  }, [open])

  // Posición por getBoundingClientRect (mismo patrón que AdminSelect /
  // ProfitabilityPopover): ancho mínimo propio en vez de calcar el ancho del
  // trigger, así los nombres largos no quedan cortados aunque la columna de
  // ícono sea angosta; clamp contra el viewport para no desbordar.
  useEffect(() => {
    if (!open) return

    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return

      const width = Math.min(
        Math.max(rect.width, MIN_POPOVER_WIDTH),
        window.innerWidth - 16,
      )
      const estimatedHeight = menuRef.current?.offsetHeight ?? 320
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < estimatedHeight + 8 && rect.top > estimatedHeight
      const left = Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - width - 8),
      )

      setPosition({
        left,
        top: openAbove
          ? Math.max(8, rect.top - estimatedHeight - 4)
          : Math.min(window.innerHeight - 8, rect.bottom + 4),
        width,
      })
    }

    updatePosition()
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)

    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
    }
  }, [open, filteredOptions.length])

  // Portalea dentro de .product-editor-screen (no a document.body): así
  // sigue siendo descendiente del selector con el que está scopeado todo el
  // CSS de este picker (.product-editor-screen .admin-icon-picker-*), pero
  // con position:fixed evita el recorte/ancho de cualquier ancestro
  // (la tarjeta de Especificaciones, la fila, etc.).
  const portalTarget =
    triggerRef.current?.closest<HTMLElement>(".product-editor-screen") ??
    (typeof document !== "undefined" ? document.body : null)

  return (
    <div className="admin-icon-picker relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Abrir buscador de iconos"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="admin-icon-picker-trigger flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border px-3.5 text-left transition-colors"
      >
        <span className="flex min-w-0 items-center gap-3">
          <SelectedIcon className="size-5 shrink-0 text-white" />
          <span className="truncate text-sm font-semibold text-white" data-icon-picker-label>
            {selectedLabel}
          </span>
        </span>
        <Search className="size-4 shrink-0 text-white/60" />
      </button>

      {mounted &&
        open &&
        portalTarget &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Íconos disponibles"
            className="admin-portal-scope admin-icon-picker-popover fixed z-100 space-y-2 rounded-2xl border p-2.5 shadow-beyonix-modal"
            style={{ left: position.left, top: position.top, width: position.width }}
          >
            <div className="admin-icon-picker-search flex min-h-11 items-center gap-2 rounded-xl border px-3">
              <Search className="size-4.5 shrink-0 text-white" />
              <input
                autoFocus
                type="search"
                aria-label="Buscar ícono"
                value={search}
                placeholder="Buscar ícono..."
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation()
                    setOpen(false)
                  }
                }}
                className="admin-icon-picker-search-input min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
              />
              <button
                type="button"
                aria-label="Cerrar buscador de iconos"
                onClick={() => setOpen(false)}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/12 bg-[#444444] text-white transition-colors hover:border-beyonix-sky/40 hover:bg-beyonix-blue"
              >
                <X className="size-4" />
              </button>
            </div>

            {aliasError && <p role="alert" className="text-xs text-red-300">{aliasError}</p>}

            <div className="grid max-h-[340px] gap-2 overflow-y-auto pr-1 custom-scrollbar">
              {filteredOptions.map((option) => {
                const Icon = option.Icon
                const displayLabel = getSpecIconDisplayLabel(option.name, aliases)
                const selected = value === option.name

                return (
                  <div key={option.name} className="min-w-0">
                    <div className="flex min-w-0 items-stretch gap-1">
                      <button
                        type="button"
                        aria-label={`Elegir ícono ${displayLabel}`}
                        title={displayLabel}
                        data-icon-name={option.name}
                        onClick={() => {
                          onChange(option.name)
                          setOpen(false)
                        }}
                        className={`admin-icon-picker-option flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl border px-2.5 py-1 text-left transition-colors ${
                          selected ? "admin-icon-picker-option-selected" : ""
                        }`}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/12 bg-[#444444] text-white">
                          <Icon className="size-4.5 text-white" />
                        </span>
                        <span className="min-w-0 truncate text-sm font-semibold leading-tight text-white">{displayLabel}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Editar nombre de ${displayLabel}`}
                        title={`Editar nombre de ${displayLabel}`}
                        onClick={() => {
                          setEditingIcon(option.name)
                          setDraftLabel(displayLabel)
                          setAliasError("")
                        }}
                        className="admin-icon-picker-edit flex min-w-11 items-center justify-center rounded-xl border border-white/14 bg-[#0c1219] text-white/75 hover:border-white/40 hover:text-white"
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                    {editingIcon === option.name && (
                      <div className="mt-1 space-y-2 rounded-xl border border-white/14 bg-[#171c22] p-2">
                        <label className="block text-xs font-semibold text-white" htmlFor={`alias-${option.name}`}>Nombre visible</label>
                        <input
                          id={`alias-${option.name}`}
                          autoFocus
                          type="text"
                          maxLength={80}
                          value={draftLabel}
                          onChange={(event) => setDraftLabel(event.target.value)}
                          onKeyDown={(event) => { if (event.key === "Enter") void saveAlias() }}
                          className="h-9 w-full rounded-lg border border-white/25 bg-[#0c1219] px-2 text-sm text-white outline-none focus:border-emerald-400"
                        />
                        <p className="text-10px leading-4 text-white/60">Sólo cambia el nombre en este selector; la tienda muestra el texto de cada característica.</p>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {aliases[option.name] && (
                            <button type="button" disabled={savingAlias} onClick={() => void resetAlias()} className="mr-auto inline-flex items-center gap-1 text-xs text-white/75 hover:text-white">
                              <RotateCcw className="size-3.5" /> Restablecer nombre
                            </button>
                          )}
                          <button type="button" disabled={savingAlias} onClick={() => { setEditingIcon(null); setAliasError("") }} className="rounded-lg px-2 py-1 text-xs text-white/75 hover:text-white">Cancelar</button>
                          <button type="button" disabled={savingAlias} onClick={() => void saveAlias()} className="rounded-lg border border-emerald-400/50 bg-emerald-500/20 px-2 py-1 text-xs font-bold text-white hover:bg-emerald-500/30">Guardar</button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {!filteredOptions.length && (
              <div className="rounded-xl border border-white/10 bg-[#111820] px-4 py-4 text-center">
                <p className="text-sm text-white/50">No encontramos íconos.</p>
              </div>
            )}
          </div>,
          portalTarget,
        )}
    </div>
  )
}
