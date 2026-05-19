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
      className="relative flex items-center gap-3"
    >
      <span className="text-sm font-medium tracking-wide text-white/60">
        Filtrar por:
      </span>

      <div className="relative">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          className="flex min-w-180px items-center justify-between rounded-2xl border border-white/10 bg-black/60 px-5 py-2 text-sm font-medium text-white backdrop-blur-md transition hover:border-white/20"
        >
          <span>{selected.label}</span>
          <span className="ml-4 text-white/70">▼</span>
        </button>

        {isOpen && (
          <div className="absolute right-0 mt-2 w-full overflow-hidden rounded-lg border border-white/10 bg-[#112A43]/95 backdrop-blur-xl shadow-2xl z-50">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onSortChange(option.value)
                  setIsOpen(false)
                }}
                className="block w-full px-5 py-3 text-left text-sm text-white transition hover:bg-white/10"
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