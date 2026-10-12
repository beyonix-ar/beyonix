"use client"

import { useId, useRef, useState } from "react"
import { CircleHelp } from "lucide-react"

/**
 * Ayuda "(?)" discreta: se abre con hover, foco o click (mobile) y se cierra
 * con Escape o al salir. Superficie opaca con los tokens de Admin (Light/Dark).
 */
export function AdminHelpTip({ text, label }: { text: string; label: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const pointerClick = useRef(false)

  return (
    <span
      className="admin-help-tip"
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true) }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false) }}
    >
      <button
        type="button"
        className="admin-help-tip-trigger"
        aria-label={`Ayuda: ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerDown={() => { pointerClick.current = true }}
        onClick={() => {
          setOpen((current) => pointerClick.current ? !current : true)
          pointerClick.current = false
        }}
        onFocus={() => { if (!pointerClick.current) setOpen(true) }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false)
        }}
      >
        <CircleHelp className="size-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <span role="tooltip" id={id} className="admin-help-tip-popover">
          {text}
        </span>
      ) : null}
    </span>
  )
}
