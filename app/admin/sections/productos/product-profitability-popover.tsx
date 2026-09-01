"use client"

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { createPortal } from "react-dom"
import { Eye } from "lucide-react"

import type { ProductProfitabilitySimulation } from "@/lib/pricing/product-pricing"

interface ProfitabilityPopoverProps {
  simulation: ProductProfitabilitySimulation | null
  price: number | null
  priceFormatter: Intl.NumberFormat
}

const CLOSE_DELAY_MS = 150

/**
 * Ícono de ojo + panel flotante con la rentabilidad estimada por medio de
 * pago. 100% presentacional: no recalcula nada, sólo formatea `simulation`
 * (ya calculada arriba, en producto-form.tsx, a partir del precio/costo/
 * cuotas vigentes) en una fila compacta por escenario.
 *
 * Posicionamiento por getBoundingClientRect + portal a document.body, mismo
 * patrón que AdminSelect en admin-controls.tsx (evita reinventar el cálculo
 * de flip/clamp dentro del viewport).
 */
export function ProfitabilityPopover({
  simulation,
  price,
  priceFormatter,
}: ProfitabilityPopoverProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 430 })

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

      const width = Math.min(600, Math.max(430, window.innerWidth - 32))
      const estimatedHeight = panelRef.current?.offsetHeight ?? 240
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < estimatedHeight + 12 && rect.top > estimatedHeight
      const left = Math.min(
        Math.max(8, rect.left),
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
  }, [open, simulation])

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
        title="Ver rentabilidad estimada"
        aria-label="Ver rentabilidad estimada"
        aria-expanded={open}
        aria-haspopup="dialog"
        onPointerEnter={handleMouseEnter}
        onPointerLeave={handleMouseLeave}
        onClick={() => {
          clearCloseTimeout()
          setOpen((current) => !current)
        }}
        className="product-editor-eye-trigger inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-white/14 bg-white/[0.03] text-white outline-none transition-colors hover:border-white/32 hover:bg-white/[0.07]"
      >
        <Eye className="size-4 text-white" />
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Rentabilidad estimada"
            onPointerEnter={handleMouseEnter}
            onPointerLeave={handleMouseLeave}
            className="admin-portal-scope fixed z-100 rounded-2xl border border-[rgba(92,159,215,0.28)] bg-[#07111b] p-3 shadow-[0_22px_52px_rgba(0,0,0,0.52)]"
            style={{ left: position.left, top: position.top, width: position.width }}
          >
            <p className="mb-2 text-10px font-black uppercase tracking-widest text-white">
              Rentabilidad estimada
            </p>

            {simulation ? (
              <div className="space-y-1">
                {simulation.scenarios.map((scenario) => {
                  const isWorstCase = scenario.id === simulation.worstCase.id
                  const safePrice = price ?? 0
                  const feeAmount = (safePrice * scenario.ratePercent) / 100
                  const chargedAmount =
                    scenario.kind === "discount" ? safePrice - feeAmount : safePrice

                  return (
                    <div
                      key={scenario.id}
                      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-2.5 py-1.5 text-xs ${
                        isWorstCase
                          ? "border-beyonix-sky/30 bg-beyonix-blue/[0.08]"
                          : "border-white/8 bg-black/20"
                      }`}
                    >
                      <span className="flex min-w-0 shrink-0 items-center gap-1.5 font-black text-white">
                        {scenario.label}
                        <span
                          className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-9px font-black text-white ${
                            scenario.marginPercent < 0
                              ? "border-red-400/40 bg-red-500/20"
                              : "border-emerald-400/40 bg-emerald-500/20"
                          }`}
                        >
                          {scenario.marginPercent.toFixed(1)}%
                        </span>
                      </span>
                      <span className="text-white">
                        Ganancia: {priceFormatter.format(scenario.profitAmount)} ·{" "}
                        {scenario.kind === "discount"
                          ? `Cliente paga ${priceFormatter.format(chargedAmount)}`
                          : `MP retiene ${priceFormatter.format(feeAmount)} (${scenario.ratePercent}%)`}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs leading-5 text-white">
                Cargá un precio y un costo de compra para ver la rentabilidad estimada.
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
