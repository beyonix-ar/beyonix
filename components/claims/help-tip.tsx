"use client"

import { useId } from "react"
import { CircleQuestionMark } from "lucide-react"

/**
 * Ayuda contextual "(?)": tooltip que aparece en hover y en foco de teclado.
 * Sólo CSS (.admin-claim-help*, globals.css), sin dependencias; el texto
 * queda enlazado por aria-describedby para lectores de pantalla. La burbuja
 * se abre hacia la izquierda del trigger: ubicarlo al final de su fila.
 *
 * Escape oculta el tooltip (quita el foco) sin cerrar el modal que lo
 * contenga; un segundo Escape ya llega al modal.
 */
export function HelpTip({ label, children }: { label: string; children: string }) {
  const tooltipId = useId()

  return (
    <span className="admin-claim-help">
      <button
        type="button"
        aria-label={`Ayuda: ${label}`}
        aria-describedby={tooltipId}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return
          event.stopPropagation()
          event.currentTarget.blur()
        }}
        className="admin-claim-help-trigger admin-claim-flow-control"
      >
        <CircleQuestionMark className="size-3.5" />
      </button>
      <span role="tooltip" id={tooltipId} className="admin-claim-help-bubble">
        {children}
      </span>
    </span>
  )
}
