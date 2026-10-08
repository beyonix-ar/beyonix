"use client"

import { useId, useState } from "react"
import { CircleHelp } from "lucide-react"

/**
 * Ayuda "(?)" discreta: se abre con hover, foco o click (mobile) y se cierra
 * con Escape o al salir. Superficie opaca con los tokens de Admin (Light/Dark).
 */
export function AdminHelpTip({ text, label }: { text: string; label: string }) {
  const id = useId()
  const [open, setOpen] = useState(false)

  return (
    <span
      className="admin-help-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="admin-help-tip-trigger"
        aria-label={`Ayuda: ${label}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onFocus={() => setOpen(true)}
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
