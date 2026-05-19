"use client"

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { useRouter } from "next/navigation"
import { productsData } from "@/lib/products"

interface GlobalSearchBarProps {
  search: string
  onSearchChange: (value: string) => void
}

export function GlobalSearchBar({
  search,
  onSearchChange,
}: GlobalSearchBarProps) {
  const router = useRouter()

  const [isFocused, setIsFocused] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)

  const suggestions = useMemo(() => {
    if (!search.trim()) return []

    return productsData
      .filter((product) =>
        product.name
          .toLowerCase()
          .includes(search.toLowerCase())
      )
      .slice(0, 5)
  }, [search])

  const handleSearch = () => {
    router.push(`/productos?search=${encodeURIComponent(search)}`)
    setIsFocused(false)
  }

  return (
    <div className="relative w-full">
      <div
        className={`flex overflow-hidden rounded-xl border bg-[#0A0A0A] transition-all duration-200 ${
          isFocused
            ? "border-[#1E4D7B] shadow-[0_0_0_3px_rgba(17,42,67,0.4)]"
            : "border-white/[0.08] hover:border-white/[0.15]"
        }`}
      >
        <input
          type="text"
          placeholder="Buscá tecnología pensada para vos..."
          value={search}
          onChange={(e) => {
            onSearchChange(e.target.value)
            setSelectedIndex(-1)
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            // Delay para permitir click en sugerencias
            setTimeout(() => setIsFocused(false), 150)
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault()
              setSelectedIndex((prev) =>
                prev < suggestions.length - 1 ? prev + 1 : prev
              )
            }

            if (e.key === "ArrowUp") {
              e.preventDefault()
              setSelectedIndex((prev) =>
                prev > 0 ? prev - 1 : prev
              )
            }

            if (e.key === "Enter") {
              if (selectedIndex >= 0 && suggestions[selectedIndex]) {
                const selected = suggestions[selectedIndex]
                onSearchChange(selected.name)

                router.push(
                  `/productos?search=${encodeURIComponent(selected.name)}`
                )
              } else {
                handleSearch()
              }

              setIsFocused(false)
            }

            if (e.key === "Escape") {
              setIsFocused(false)
            }
          }}
          className="w-full bg-transparent px-5 py-3.5 text-sm text-white placeholder:text-white/35 outline-none"
        />

        <button
          onClick={handleSearch}
          aria-label="Buscar productos"
          className="border-l border-white/[0.08] px-5 text-white/40 transition-colors hover:text-white/80 cursor-pointer"
        >
          <Search className="size-4" />
        </button>
      </div>

      {/* SUGERENCIAS */}
      {isFocused && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 mt-1.5 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0D0D0D] shadow-2xl shadow-black/70 z-50">
          {suggestions.map((product, index) => (
            <button
              key={product.id}
              type="button"
              onClick={() => {
                onSearchChange(product.name)

                router.push(
                  `/productos?search=${encodeURIComponent(product.name)}`
                )

                setIsFocused(false)
              }}
              className={`flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left text-sm transition-colors ${
                index < suggestions.length - 1
                  ? "border-b border-white/[0.05]"
                  : ""
              } ${
                index === selectedIndex
                  ? "bg-[#112A43]/60 text-white"
                  : "text-white/60 hover:bg-white/[0.04] hover:text-white"
              }`}
            >
              <Search className="size-3.5 shrink-0 text-white/25" />
              {product.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}