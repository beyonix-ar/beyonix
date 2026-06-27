"use client"

import { useEffect, useRef, useState } from "react"

interface CategorySortProps {
  sortBy: string
  onSortChange: (value: string) => void
}

const options = [
  { value: "default", label: "Relevancia" },
  { value: "featured", label: "Más vendidos" },
  { value: "price-asc", label: "Menor precio" },
  { value: "price-desc", label: "Mayor precio" },
]

export function CategorySort({
  sortBy,
  onSortChange,
}: CategorySortProps) {
  const [isOpen, setIsOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)

    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [])

  const selected =
    options.find((option) => option.value === sortBy) ?? options[0]

  return (
    <div
      ref={wrapperRef}
      className="relative flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <span className="text-sm font-medium tracking-wide text-white/70">
        Filtrar por:
      </span>

      <div className="relative w-full sm:w-auto">
        <button
          type="button"
          aria-label="Abrir orden de categoría"
          title="Ordenar productos"
          onClick={() => setIsOpen((prev) => !prev)}
          className="flex min-h-44px w-full cursor-pointer items-center justify-between rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#0B111A]/90 px-4 py-2 text-sm font-medium text-[#F8FAFC] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-md transition-all duration-200 hover:border-[rgba(191,228,255,0.28)] hover:bg-[rgba(17,42,67,0.45)] hover:text-[#D7ECFF] hover:shadow-[0_0_18px_rgba(96,165,250,0.18)] sm:min-w-180px"
        >
          <span>{selected.label}</span>
          <span className="ml-4 text-white/80">▼</span>
        </button>

        {isOpen && (
          <div className="absolute right-0 z-50 mt-2 w-full overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] shadow-[0_18px_45px_rgba(0,0,0,0.45)] backdrop-blur-xl">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={`Ordenar por ${option.label}`}
                title={`Ordenar por ${option.label}`}
                onClick={() => {
                  onSortChange(option.value)
                  setIsOpen(false)
                }}
                className="block w-full cursor-pointer border-b border-white/8 px-5 py-3 text-left text-sm text-[#F8FAFC] transition-all duration-200 last:border-b-0 hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF] hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)]"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
