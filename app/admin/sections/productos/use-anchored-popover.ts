"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react"

const HOVER_OPEN_DELAY_MS = 180
const HOVER_CLOSE_DELAY_MS = 150
const VIEWPORT_MARGIN = 8

/**
 * Panel flotante anclado a un disparador (portal a document.body, mismo
 * cálculo de flip/clamp que AdminRowMenu y el popover de rentabilidad):
 * se cierra con click afuera o Escape (devolviendo el foco al disparador) y,
 * con `hover`, también se abre al pasar el mouse con una pequeña demora para
 * que recorrer el listado no dispare aperturas.
 */
export function useAnchoredPopover({ width, hover = false }: { width: number; hover?: boolean }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, width })

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  useEffect(() => clearTimer, [clearTimer])

  const updatePosition = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return
    const panelWidth = Math.min(width, window.innerWidth - VIEWPORT_MARGIN * 2)
    const height = panelRef.current?.offsetHeight ?? 160
    const openAbove = window.innerHeight - rect.bottom < height + 12 && rect.top > height + 12
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.right - panelWidth),
      window.innerWidth - panelWidth - VIEWPORT_MARGIN,
    )
    const top = openAbove
      ? Math.max(VIEWPORT_MARGIN, rect.top - height - 6)
      : Math.min(window.innerHeight - height - VIEWPORT_MARGIN, rect.bottom + 6)
    setPosition((current) =>
      current.left === left && current.top === top && current.width === panelWidth
        ? current
        : { left, top, width: panelWidth },
    )
  }, [width])

  // Sin deps: el contenido (cargando → resultado) cambia la altura del panel.
  useLayoutEffect(() => {
    if (open) updatePosition()
  })

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
      anchorRef.current?.querySelector<HTMLElement>("button")?.focus()
    }
    window.addEventListener("resize", updatePosition)
    window.addEventListener("scroll", updatePosition, true)
    document.addEventListener("mousedown", handlePointerDown)
    document.addEventListener("keydown", handleEscape)
    return () => {
      window.removeEventListener("resize", updatePosition)
      window.removeEventListener("scroll", updatePosition, true)
      document.removeEventListener("mousedown", handlePointerDown)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [open, updatePosition])

  const toggle = useCallback(() => {
    clearTimer()
    setOpen((current) => !current)
  }, [clearTimer])

  const close = useCallback(() => {
    clearTimer()
    setOpen(false)
  }, [clearTimer])

  const onPointerEnter = (event: ReactPointerEvent) => {
    if (!hover || event.pointerType !== "mouse") return
    clearTimer()
    if (!open) timerRef.current = setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS)
  }

  const onPointerLeave = (event: ReactPointerEvent) => {
    if (!hover || event.pointerType !== "mouse") return
    clearTimer()
    timerRef.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }

  return {
    anchorRef,
    panelRef,
    open,
    position,
    toggle,
    close,
    hoverHandlers: { onPointerEnter, onPointerLeave },
  }
}
