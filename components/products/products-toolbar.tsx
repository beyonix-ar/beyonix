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
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-beyonix-blue-light/18 bg-[#071018]/82 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] sm:flex-row sm:items-center sm:justify-between">

      {/* Contador */}
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-medium text-white/56">
          Mostrando
        </span>
        <span className="text-lg font-bold tracking-tight text-beyonix-sky tabular-nums">
          {total}
        </span>
        <span className="text-sm font-medium text-white/56">
          {total === 1 ? "resultado" : "resultados"}
        </span>
      </div>

      {/* Selector de orden */}
      <div ref={containerRef} className="relative w-full sm:w-auto">
        <button
          type="button"
          aria-label="Ordenar productos"
          onClick={() => setOpen(!open)}
          className={`flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm transition-all duration-150 sm:w-auto ${
            open
              ? "border-[rgba(191,228,255,0.42)] bg-[rgba(17,42,67,0.45)] text-[#D7ECFF] shadow-[0_0_18px_rgba(96,165,250,0.18)]"
              : "border-[rgba(148,197,255,0.18)] bg-[#0B111A]/90 text-[#F8FAFC] hover:border-[rgba(191,228,255,0.28)] hover:bg-[rgba(17,42,67,0.45)] hover:text-[#D7ECFF]"
          }`}
        >
          <span className="font-medium">{selected}</span>
          <ChevronDown
            className={`size-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] shadow-[0_18px_45px_rgba(0,0,0,0.45)]">
            {options.map((option, i) => (
              <button
                key={option.value}
                type="button"
                aria-label={`Ordenar por ${option.label}`}
                onClick={() => {
                  setSortBy(option.value)
                  setOpen(false)
                }}
                className={`flex w-full cursor-pointer items-center justify-between px-4 py-2.5 text-sm transition-all duration-200 hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)] ${
                  i < options.length - 1 ? "border-b border-white/8" : ""
                } ${
                  option.value === sortBy
                    ? "bg-[rgba(17,42,67,0.9)] text-[#D7ECFF]"
                    : "text-[#F8FAFC] hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF]"
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
