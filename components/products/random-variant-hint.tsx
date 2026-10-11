"use client"

import { useId, useRef, useState } from "react"
import { CircleHelp } from "lucide-react"

import { RANDOM_VARIANT_TOOLTIP } from "@/lib/products/product-variants"

/** "(?)" de la venta aleatoria: hover, foco o toque; Escape lo cierra. */
export function RandomVariantHint() {
  const id = useId()
  const [open, setOpen] = useState(false)
  const touchWasOpen = useRef(false)
  const touchClick = useRef(false)

  return (
    <span
      className="relative inline-flex align-middle"
      onPointerEnter={(event) => { if (event.pointerType === "mouse") setOpen(true) }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") setOpen(false) }}
    >
      <button
        type="button"
        aria-label="Qué significa color/modelo aleatorio"
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onPointerDown={(event) => {
          touchClick.current = event.pointerType === "touch"
          if (touchClick.current) touchWasOpen.current = open
        }}
        onClick={() => setOpen(touchClick.current ? !touchWasOpen.current : true)}
        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setOpen(true) }}
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
