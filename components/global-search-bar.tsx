"use client"

import {
  useMemo,
  useState,
} from "react"

import { Search } from "lucide-react"

import { useRouter } from "next/navigation"

interface SearchProduct {
  id: string
  nombre: string
}

interface GlobalSearchBarProps {
  search: string

  products: SearchProduct[]

  onSearchChange: (
    value: string
  ) => void
}

export function GlobalSearchBar({
  search,
  products,
  onSearchChange,
}: GlobalSearchBarProps) {
  const router = useRouter()

  const [isFocused, setIsFocused] =
    useState(false)

  const [selectedIndex, setSelectedIndex] =
    useState(-1)

  const suggestions = useMemo(() => {
    const value =
      search
        .trim()
        .toLowerCase()

    if (!value) {
      return []
    }

    return products
      .filter((product) =>
        product.nombre
          .toLowerCase()
          .includes(value)
      )
      .slice(0, 5)
  }, [products, search])

  const redirectSearch = (
    value: string
  ) => {
    router.push(
      `/productos?search=${encodeURIComponent(value)}`
    )

    setIsFocused(false)
  }

  return (
    <div className="relative w-full">
      <div
        className={`flex overflow-hidden rounded-xl border bg-[#0A0A0A] transition-all duration-200 ${
          isFocused
            ? "border-[#1E4D7B] shadow-lg"
            : "border-white/[0.08] hover:border-white/[0.15]"
        }`}
      >
        <input
          type="text"
          placeholder="Buscá tecnología pensada para vos..."
          value={search}
          onChange={(event) => {
            onSearchChange(
              event.target.value
            )

            setSelectedIndex(-1)
          }}
          onFocus={() =>
            setIsFocused(true)
          }
          onBlur={() =>
            setTimeout(
              () =>
                setIsFocused(
                  false
                ),
              150
            )
          }
          onKeyDown={(event) => {
            if (
              event.key ===
              "ArrowDown"
            ) {
              event.preventDefault()

              setSelectedIndex(
                (prev) =>
                  prev <
                  suggestions.length -
                    1
                    ? prev + 1
                    : prev
              )
            }

            if (
              event.key ===
              "ArrowUp"
            ) {
              event.preventDefault()

              setSelectedIndex(
                (prev) =>
                  prev > 0
                    ? prev - 1
                    : prev
              )
            }

            if (
              event.key ===
              "Escape"
            ) {
              setIsFocused(false)
            }

            if (
              event.key ===
              "Enter"
            ) {
              redirectSearch(
                suggestions[
                  selectedIndex
                ]?.nombre ||
                  search
              )
            }
          }}
          className="w-full bg-transparent px-5 py-3.5 text-sm text-white outline-none placeholder:text-white/35"
        />

        <button
          type="button"
          aria-label="Buscar productos"
          title="Buscar productos"
          onClick={() =>
            redirectSearch(
              search
            )
          }
          className="cursor-pointer border-l border-white/[0.08] px-5 text-white/40 transition-colors hover:text-white/80"
        >
          <Search className="size-4" />
        </button>
      </div>

      {isFocused &&
        suggestions.length >
          0 && (
          <div className="absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0D0D0D] shadow-2xl shadow-black/70">
            {suggestions.map(
              (
                product,
                index
              ) => (
                <button
                  key={
                    product.id
                  }
                  type="button"
                  aria-label={
                    product.nombre
                  }
                  title={
                    product.nombre
                  }
                  onClick={() => {
                    onSearchChange(
                      product.nombre
                    )

                    redirectSearch(
                      product.nombre
                    )
                  }}
                  className={`flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left text-sm transition-colors ${
                    index <
                    suggestions.length -
                      1
                      ? "border-b border-white/[0.05]"
                      : ""
                  } ${
                    index ===
                    selectedIndex
                      ? "bg-[#112A43]/60 text-white"
                      : "text-white/60 hover:bg-white/[0.04] hover:text-white"
                  }`}
                >
                  <Search className="size-3.5 shrink-0 text-white/25" />

                  {
                    product.nombre
                  }
                </button>
              )
            )}
          </div>
        )}
    </div>
  )
}