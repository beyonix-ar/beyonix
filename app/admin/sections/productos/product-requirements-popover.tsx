"use client"

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { createPortal } from "react-dom"
import { Check, ClipboardCheck, X } from "lucide-react"

import type { ProductActivationStatus } from "@/lib/products/product-activation"

interface RequirementsPopoverProps {
  status: ProductActivationStatus
}

const CLOSE_DELAY_MS = 150

/**
 * Ícono de checklist + panel flotante con "Requisitos para activar". 100%
 * presentacional: no recalcula nada, sólo muestra `status` (ya calculado
 * arriba, en producto-form.tsx, vía getProductActivationStatus) -- mismo
 * patrón de portal + hover/click que ProfitabilityPopover (evita reinventar
 * el cálculo de posición/flip dentro del viewport ni la lógica de
 * apertura/cierre por mouse vs. touch).
 */
export function ProductRequirementsPopover({ status }: RequirementsPopoverProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280 })

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(
    () => () => {
      if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current)
    },
    [],
  )

  const clearCloseTimeout = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current)
      closeTimeoutRef.current = null
    }
  }

  const scheduleClose = () => {
    clearCloseTimeout()
    closeTimeoutRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }

  useEffect(() => {
    if (!open) return

    function updatePosition() {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return

      const width = Math.min(300, Math.max(260, window.innerWidth - 32))
      const estimatedHeight = panelRef.current?.offsetHeight ?? 200
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < estimatedHeight + 12 && rect.top > estimatedHeight
      const left = Math.min(
        Math.max(8, rect.right - width),
        Math.max(8, window.innerWidth - width - 8),
      )

      setPosition({
        left,
        top: openAbove
          ? Math.max(8, rect.top - estimatedHeight - 8)
          : Math.min(window.innerHeight - 8, rect.bottom + 8),
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
  }, [open, status])

  useEffect(() => {
    if (!open) return

    function handlePointerDownOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
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

  const handleMouseEnter = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return
    clearCloseTimeout()
    setOpen(true)
  }

  const handleMouseLeave = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return
    scheduleClose()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title="Requisitos para activar"
        aria-label="Requisitos para activar"
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerEnter={handleMouseEnter}
        onPointerLeave={handleMouseLeave}
        onClick={() => {
          clearCloseTimeout()
          setOpen((current) => !current)
        }}
        className={`admin-ds-button inline-flex size-10 min-h-0 shrink-0 cursor-pointer items-center justify-center border px-0 py-0 outline-none transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45 ${
          status.ready
            ? "border-emerald-400/55 bg-emerald-400/10 hover:border-emerald-400/75 hover:bg-emerald-400/15"
            : "border-amber-400/55 bg-amber-400/10 hover:border-amber-400/75 hover:bg-amber-400/15"
        }`}
      >
        <ClipboardCheck
          className={`size-4 ${status.ready ? "text-emerald-300" : "text-amber-300"}`}
        />
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Requisitos para activar"
            onPointerEnter={handleMouseEnter}
            onPointerLeave={handleMouseLeave}
            className="admin-portal-scope fixed z-100 rounded-2xl border border-[rgba(92,159,215,0.28)] bg-[#07111b] p-3 shadow-[0_22px_52px_rgba(0,0,0,0.52)]"
            style={{ left: position.left, top: position.top, width: position.width }}
          >
            <p className="mb-2 text-10px font-black uppercase tracking-widest text-white">
              Requisitos para activar
            </p>
            <div className="space-y-1">
              {status.requirements.map((requirement) => (
                <span
                  key={requirement.key}
                  className={`flex min-w-0 items-center gap-1.5 text-xs font-semibold ${
                    requirement.complete ? "text-emerald-300" : "text-white"
                  }`}
                >
                  {requirement.complete ? (
                    <Check className="size-3 shrink-0 text-emerald-300" aria-hidden="true" />
                  ) : (
                    <X className="size-3 shrink-0 text-rose-300" aria-hidden="true" />
                  )}
                  <span className="truncate">{requirement.label}</span>
                </span>
              ))}
            </div>
            {status.firstError && (
              <p className="mt-2 text-10px font-semibold leading-4 text-white">
                {status.firstError}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
