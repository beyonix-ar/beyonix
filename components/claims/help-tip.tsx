"use client"

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { CircleQuestionMark } from "lucide-react"

const VIEWPORT_MARGIN = 8
const GAP = 8
const MAX_WIDTH = 256

interface BubblePosition {
  top: number
  left: number
  maxWidth: number
  arrowX: number
  below: boolean
}

/**
 * Ayuda (?) accesible: se abre con hover o foco y se cierra con Escape.
 * La burbuja se posiciona respecto de la pantalla (position: fixed), así
 * ningún contenedor con overflow la recorta: abre hacia arriba si hay lugar
 * y si no hacia abajo, con el ancho y el borde horizontal acotados al viewport.
 */
export function HelpTip({ label, children, align = "end" }: { label: string; children: string; align?: "start" | "end" }) {
  const tooltipId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<BubblePosition | null>(null)

  const place = useCallback(() => {
    const trigger = triggerRef.current
    const bubble = bubbleRef.current
    if (!trigger || !bubble) return
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth
    const viewportHeight = window.innerHeight
    const maxWidth = Math.min(MAX_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2)
    bubble.style.maxWidth = `${maxWidth}px`
    const rect = trigger.getBoundingClientRect()
    const width = bubble.offsetWidth
    const height = bubble.offsetHeight
    const preferred = align === "start" ? rect.left - 4 : rect.right - width + 4
    const left = Math.min(Math.max(preferred, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN))
    const fitsAbove = rect.top - height - GAP >= VIEWPORT_MARGIN
    const fitsBelow = rect.bottom + height + GAP <= viewportHeight - VIEWPORT_MARGIN
    const below = !fitsAbove && (fitsBelow || rect.top < viewportHeight - rect.bottom)
    const top = below ? rect.bottom + GAP : rect.top - height - GAP
    const arrowX = Math.min(Math.max(rect.left + rect.width / 2 - left, 10), width - 10)
    setPosition({ top, left, maxWidth, arrowX, below })
  }, [align])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    // Scroll de cualquier contenedor o cambio de tamaño: la burbuja sigue al (?).
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [open, place])

  const style: CSSProperties | undefined = open && position
    ? {
        position: "fixed", top: position.top, left: position.left, right: "auto", bottom: "auto",
        maxWidth: position.maxWidth, zIndex: 1000, ["--help-arrow-x" as string]: `${position.arrowX}px`,
      }
    : undefined

  return (
    <span
      className={`admin-claim-help ${align === "start" ? "is-align-start" : ""} ${open && position ? "is-open" : ""} ${position?.below ? "is-below" : ""}`}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false) }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false) }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Ayuda: ${label}`}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.stopPropagation()
          setOpen(false)
          event.currentTarget.blur()
        }}
        className="admin-claim-help-trigger admin-claim-flow-control"
      >
        <CircleQuestionMark className="size-3.5" />
      </button>
      <span ref={bubbleRef} role="tooltip" id={tooltipId} className="admin-claim-help-bubble" style={style}>{children}</span>
    </span>
  )
}
