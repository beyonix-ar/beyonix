"use client"

import { useId, useState } from "react"
import { CircleHelp } from "lucide-react"

import { RANDOM_VARIANT_TOOLTIP } from "@/lib/products/product-variants"

/** "(?)" de la venta aleatoria: hover, foco o toque; Escape lo cierra. */
export function RandomVariantHint() {
  const id = useId()
  const [open, setOpen] = useState(false)

  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="Qué significa color/modelo aleatorio"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false)
        }}
        className="flex size-6 cursor-pointer items-center justify-center rounded-full text-white/60 transition-colors hover:text-beyonix-sky focus-visible:text-beyonix-sky"
      >
        <CircleHelp className="size-4" aria-hidden="true" />
      </button>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className="absolute left-1/2 top-full z-40 mt-1.5 w-[min(16rem,calc(100vw-3rem))] -translate-x-1/2 rounded-xl border border-white/12 bg-[#0B131C] px-3 py-2 text-13px font-normal leading-5 text-white/85 shadow-xl shadow-black/50"
        >
          {RANDOM_VARIANT_TOOLTIP}
        </span>
      ) : null}
    </span>
  )
}
