"use client"

import { useState, type FormEvent } from "react"
import { createPortal } from "react-dom"
import { Loader2, Star } from "lucide-react"

import {
  FEATURED_POSITION_MAX,
  type ProductFeaturedState,
} from "@/lib/products/featured-products"

import { AdminPrimaryButton, AdminSecondaryButton } from "../../components/admin-controls"
import { useAnchoredPopover } from "./use-anchored-popover"

interface ProductFeaturedControlProps {
  productName: string
  state: ProductFeaturedState
  /** `null` = se puede editar; un texto = por qué no (se muestra como título). */
  disabledReason: string | null
  /** Persiste el cambio; si falla, lanza un Error con el mensaje para Admin. */
  onChange: (next: ProductFeaturedState) => Promise<void>
  /** "row": botón de la columna Acciones; "toolbar": botón de la barra del editor. */
  variant: "row" | "toolbar"
}

function describe(state: ProductFeaturedState) {
  if (!state.destacado) return "No destacado"
  return state.featuredPosition == null
    ? "Destacado sin posición"
    : `Destacado en la posición ${state.featuredPosition}`
}

/**
 * Único control de destacado de Admin → Productos (columna Acciones y
 * estrella del editor): muestra si el producto está destacado y su posición
 * (☆ / ★ 2) y permite destacar, cambiar la posición o quitar el destacado.
 * La fuente de verdad es la base (`productos.destacado` +
 * `featured_position`); una posición ocupada se rechaza con su mensaje.
 */
export function ProductFeaturedControl({
  productName,
  state,
  disabledReason,
  onChange,
  variant,
}: ProductFeaturedControlProps) {
  const popover = useAnchoredPopover({ width: 260 })
  const [positionInput, setPositionInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const label = describe(state)

  const openPanel = () => {
    if (!popover.open) {
      setPositionInput(state.featuredPosition == null ? "" : String(state.featuredPosition))
      setError("")
    }
    popover.toggle()
  }

  const parsePosition = (): number | null | undefined => {
    const trimmed = positionInput.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > FEATURED_POSITION_MAX) {
      setError(`La posición debe ser un número entero entre 1 y ${FEATURED_POSITION_MAX}.`)
      return undefined
    }
    return parsed
  }

  const apply = async (next: ProductFeaturedState) => {
    if (saving) return
    setSaving(true)
    setError("")
    try {
      await onChange(next)
      popover.close()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "No se pudo actualizar el destacado.")
    } finally {
      setSaving(false)
    }
  }

  const submitPosition = (event?: FormEvent) => {
    event?.preventDefault()
    const position = parsePosition()
    if (position === undefined) return
    void apply({ destacado: true, featuredPosition: position })
  }

  const icon = (
    <Star
      aria-hidden="true"
      className={`size-3.5 shrink-0 ${state.destacado ? "fill-amber-300 text-amber-300" : "text-white/55"}`}
    />
  )
  const positionBadge = state.destacado && state.featuredPosition != null && (
    <span aria-hidden="true" className="text-11px font-black tabular-nums leading-none text-amber-200">
      {state.featuredPosition}
    </span>
  )
  const triggerLabel = disabledReason
    ? `${label}. ${disabledReason}`
    : `${label}. Cambiar destacado de ${productName}`
  const triggerProps = {
    "aria-label": triggerLabel,
    title: disabledReason ?? label,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": popover.open,
    disabled: Boolean(disabledReason),
    onClick: openPanel,
  }

  return (
    <span ref={popover.anchorRef} className="product-featured-control relative inline-flex">
      {variant === "row" ? (
        <button
          type="button"
          {...triggerProps}
          className={`flex h-9 min-w-9 items-center justify-center gap-1 rounded-xl border px-2 transition-colors disabled:cursor-default disabled:opacity-60 ${
            state.destacado
              ? "border-amber-300/30 bg-amber-300/8 hover:border-amber-300/55"
              : "border-white/8 hover:border-white/22"
          } ${disabledReason ? "" : "cursor-pointer"}`}
        >
          {icon}
          {positionBadge}
        </button>
      ) : (
        <AdminSecondaryButton
          size="icon"
          {...triggerProps}
          aria-pressed={state.destacado}
          className="h-10 w-auto min-w-10 gap-1 px-2"
        >
          {icon}
          {positionBadge}
        </AdminSecondaryButton>
      )}

      {popover.open &&
        createPortal(
          <div
            ref={popover.panelRef}
            role="dialog"
            aria-label={`Destacado de ${productName}`}
            className="admin-portal-scope fixed z-100 rounded-2xl border border-[rgba(92,159,215,0.28)] bg-[#07111b] p-3 text-left shadow-[0_22px_52px_rgba(0,0,0,0.52)]"
            style={{ left: popover.position.left, top: popover.position.top, width: popover.position.width }}
          >
            <p className="text-10px font-black uppercase tracking-widest text-white/55">
              Destacado en Home
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs font-bold text-white">
              {icon}
              {label}
            </p>

            <form noValidate onSubmit={submitPosition} className="mt-3 flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-11px font-bold text-white/65">
                Posición
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={FEATURED_POSITION_MAX}
                  step={1}
                  value={positionInput}
                  placeholder="Sin posición"
                  disabled={saving}
                  onChange={(event) => setPositionInput(event.target.value)}
                  className="h-9 w-full rounded-lg border border-white/12 bg-black/25 px-2.5 text-sm font-bold text-white outline-none placeholder:text-white/30 focus:border-beyonix-sky/45"
                />
              </label>
              <AdminPrimaryButton type="submit" size="sm" disabled={saving} className="h-9 shrink-0 gap-1.5">
                {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                {state.destacado ? "Guardar posición" : "Destacar"}
              </AdminPrimaryButton>
            </form>
            <p className="mt-1.5 text-10px leading-4 text-white/45">
              Sin posición se muestra después de los ordenados.
            </p>

            {state.destacado && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void apply({ destacado: false, featuredPosition: null })}
                className="mt-2.5 h-8 w-full cursor-pointer rounded-lg border border-red-400/22 text-xs font-black text-red-300 transition hover:border-red-400/45 hover:bg-red-400/10 disabled:cursor-wait disabled:opacity-50"
              >
                Quitar destacado
              </button>
            )}

            {error && (
              <p role="alert" className="mt-2.5 text-11px font-bold leading-4 text-red-300">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
    </span>
  )
}
