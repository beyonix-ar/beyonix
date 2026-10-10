"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { parseRichDescription } from "@/lib/products/rich-description"

import { RichDescription } from "./rich-description"

const FALLBACK_DESCRIPTION = "Producto seleccionado para una experiencia de compra simple y confiable."

/**
 * Descripción del producto a ancho completo, debajo de galería y compra.
 * Recortada a unas líneas con "Ver más / Ver menos" (botón a todo el ancho)
 * sólo cuando el contenido realmente excede ese alto.
 */
export function ProductDescriptionSection({
  description,
  className = "",
}: {
  description: string | null | undefined
  /** Ubicación en la grilla del contenedor (p. ej. ocupar ambas columnas). */
  className?: string
}) {
  const blocks = useMemo(() => parseRichDescription(description), [description])
  const [isExpanded, setIsExpanded] = useState(false)
  const [isClamped, setIsClamped] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = contentRef.current
    if (!element) return
    const measure = () => setIsClamped(element.scrollHeight > element.clientHeight + 1)
    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [blocks])

  const showToggle = isClamped || isExpanded

  return (
    <section
      data-product-description
      className={`beyonix-modal-header min-w-0 border-t border-white/7 px-5 py-5 md:px-7 ${className}`}
    >
      <p className="mb-2 text-11px font-bold uppercase tracking-widest text-beyonix-sky">
        Descripción
      </p>

      {blocks.length ? (
        <>
          <div
            ref={contentRef}
            className={`beyonix-modal-body min-w-0 break-words text-base font-normal leading-7 text-white/80 ${
              isExpanded ? "" : "max-h-[8.75rem] overflow-hidden"
            }`}
          >
            <RichDescription blocks={blocks} />
          </div>

          {showToggle && (
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={() => setIsExpanded((current) => !current)}
              className="mt-3 w-full cursor-pointer rounded-xl border border-white/10 bg-white/[0.03] py-2.5 text-13px font-semibold text-beyonix-sky/85 transition-colors hover:border-beyonix-sky/40 hover:text-beyonix-sky"
            >
              {isExpanded ? "Ver menos" : "Ver más"}
            </button>
          )}
        </>
      ) : (
        <p className="beyonix-modal-body text-15px leading-6 text-white/68">{FALLBACK_DESCRIPTION}</p>
      )}
    </section>
  )
}
