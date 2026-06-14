"use client"

import { useState, useRef, useEffect } from "react"
import { ChevronDown, Check } from "lucide-react"

interface ProductsToolbarProps {
  total: number
  sortBy: string
  setSortBy: (value: string) => void
}

export function ProductsToolbar({
  total,
  sortBy,
  setSortBy,
}: ProductsToolbarProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const options = [
    { label: "Relevancia", value: "relevance" },
    { label: "Menor precio", value: "price-asc" },
    { label: "Mayor precio", value: "price-desc" },
  ]

  const selected =
    options.find((o) => o.value === sortBy)?.label || "Relevancia"

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  return (
    <div className="mb-4 flex flex-col gap-2 rounded-xl border border-white/7 bg-beyonix-surface px-4 py-2 sm:flex-row sm:items-center sm:justify-between">

      {/* Contador */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-medium text-white/50">
          Mostrando
        </span>
        <span className="text-lg font-bold tracking-tight text-white tabular-nums">
          {total}
        </span>
        <span className="text-sm font-medium text-white/50">
          {total === 1 ? "resultado" : "resultados"}
        </span>
      </div>

      {/* Selector de orden */}
      <div ref={containerRef} className="relative w-full sm:w-auto">
        <button
          type="button"
          aria-label="Ordenar productos"
          title="Ordenar productos"
          onClick={() => setOpen(!open)}
          className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm transition-all duration-150 sm:w-auto ${
            open
              ? "border-[#112A43] bg-beyonix-account-active text-white"
              : "border-white/10 bg-white/4 text-white/80 hover:border-[#112A43] hover:text-white"
          }`}
        >
          <span className="font-medium">{selected}</span>
          <ChevronDown
            className={`size-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="absolute right-0 mt-2 w-44 overflow-hidden rounded-xl border border-white/8 bg-beyonix-surface-2 shadow-2xl shadow-black/60 z-50">
            {options.map((option, i) => (
              <button
                key={option.value}
                type="button"
                aria-label={`Ordenar por ${option.label}`}
                title={`Ordenar por ${option.label}`}
                onClick={() => {
                  setSortBy(option.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors cursor-pointer hover:shadow-[inset_0_0_0_1px_#112A43] ${
                  i < options.length - 1 ? "border-b border-white/5" : ""
                } ${
                  option.value === sortBy
                    ? "bg-beyonix-blue/60 text-white"
                    : "text-white/70 hover:bg-white/4 hover:text-white"
                }`}
              >
                {option.label}
                {option.value === sortBy && (
                  <Check className="size-3.5 text-beyonix-cyan" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
