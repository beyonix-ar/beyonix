import { useId } from "react"

import { cn } from "@/lib/utils"
import { RANDOM_SWATCH_COLORS } from "@/lib/products/variant-swatch"

export const RANDOM_COLOR_LABEL = "Color aleatorio"

// Seis gajos iguales desde las 12 en sentido horario (viewBox 32×32).
const SEGMENTS = RANDOM_SWATCH_COLORS.map((color, index) => {
  const point = (step: number) => {
    const angle = ((step * 60 - 90) * Math.PI) / 180
    return `${(16 + 16 * Math.cos(angle)).toFixed(3)} ${(16 + 16 * Math.sin(angle)).toFixed(3)}`
  }
  return { color, path: `M16 16L${point(index)}A16 16 0 0 1 ${point(index + 1)}Z` }
})

interface RandomColorSwatchProps {
  className?: string
  /** Dentro de un botón que ya se rotula "Color aleatorio": sin rol propio. */
  decorative?: boolean
}

/** Swatch circular multicolor de la opción "aleatorio" (catálogo, modal y vista previa del admin). */
export function RandomColorSwatch({ className, decorative = false }: RandomColorSwatchProps) {
  const glossId = `random-swatch-gloss-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`

  return (
    <span
      data-random-swatch
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": RANDOM_COLOR_LABEL, title: RANDOM_COLOR_LABEL })}
      className={cn("inline-block size-4 shrink-0 rounded-full", className)}
    >
      <svg viewBox="0 0 32 32" className="block size-full" aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id={glossId} cx="35%" cy="28%" r="75%">
            <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.38" />
            <stop offset="55%" stopColor="#FFFFFF" stopOpacity="0" />
          </radialGradient>
        </defs>
        {SEGMENTS.map((segment) => (
          <path key={segment.color} d={segment.path} fill={segment.color} stroke="#FFFFFF" strokeOpacity="0.7" strokeWidth="1" strokeLinejoin="round" />
        ))}
        <circle cx="16" cy="16" r="16" fill={`url(#${glossId})`} />
        <circle cx="16" cy="16" r="15.25" fill="none" stroke="#FFFFFF" strokeOpacity="0.35" strokeWidth="1.5" />
      </svg>
    </span>
  )
}
