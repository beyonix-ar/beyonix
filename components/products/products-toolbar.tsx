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
    <div className="mb-5 flex items-center justify-between rounded-xl border border-white/7 bg-beyonix-surface px-5 py-3.5">

      {/* Contador */}
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold tracking-tight text-white tabular-nums">
          {total}
        </span>
        <span className="text-sm text-white/50">
          {total === 1 ? "producto" : "productos"}
        </span>
      </div>

      {/* Selector de orden */}
      <div ref={containerRef} className="relative">
        <button
          type="button"
          aria-label="Ordenar productos"
          title="Ordenar productos"
          onClick={() => setOpen(!open)}
          className={`flex items-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-all duration-150 cursor-pointer ${
            open
              ? "border-beyonix-blue-light bg-beyonix-account-active text-white"
              : "border-white/10 bg-white/4 text-white/80 hover:border-white/20 hover:text-white"
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
                className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors cursor-pointer ${
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
