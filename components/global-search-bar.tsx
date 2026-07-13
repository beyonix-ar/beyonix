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
  className?: string
  surfaceClassName?: string
  inputClassName?: string
  buttonClassName?: string

  onSearchChange: (
    value: string
  ) => void
}

export function GlobalSearchBar({
  search,
  products,
  className = "",
  surfaceClassName = "",
  inputClassName = "",
  buttonClassName = "",
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
    <div className={`relative w-full ${className}`}>
      <div
        className={`flex overflow-hidden rounded-xl border bg-[#071018]/78 shadow-[0_0_30px_rgba(30,140,255,0.10),inset_0_1px_0_rgba(255,255,255,0.055)] backdrop-blur-md transition-all duration-200 ${
          isFocused
            ? "border-beyonix-sky/55 shadow-[0_0_32px_rgba(30,140,255,0.24)]"
            : "border-beyonix-blue-light/24 hover:border-beyonix-sky/36"
        } ${surfaceClassName}`}
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
          className={`w-full bg-transparent px-5 py-3.5 text-sm text-white outline-none placeholder:text-white/45 ${inputClassName}`}
        />

        <button
          type="button"
          aria-label="Buscar productos"
          onClick={() =>
            redirectSearch(
              search
            )
          }
          className={`cursor-pointer border-l border-beyonix-blue-light/20 px-5 text-beyonix-sky/70 transition-colors hover:bg-beyonix-blue/20 hover:text-white ${buttonClassName}`}
        >
          <Search className="size-4" />
        </button>
      </div>

      {isFocused &&
        suggestions.length >
          0 && (
          <div className="absolute left-0 right-0 z-50 mt-1.5 overflow-hidden rounded-xl border border-beyonix-blue-light/24 bg-[#071018] shadow-2xl shadow-black/70">
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
                      ? "border-b border-white/5"
                      : ""
                  } ${
                    index ===
                    selectedIndex
                      ? "bg-beyonix-blue/60 text-white"
                      : "text-white/70 hover:bg-white/4 hover:text-white"
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
