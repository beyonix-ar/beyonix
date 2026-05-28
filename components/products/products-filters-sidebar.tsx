"use client"

import { CommerceFilter } from "./filters/commerce-filter"
import { PriceFilter } from "./filters/price-filter"
import { CategoryFilter } from "./filters/category-filter"
import { ColorFilter } from "./filters/color-filter"

interface ProductsFiltersSidebarProps {
  selectedCategories: string[]
  setSelectedCategories: (value: string[]) => void
  selectedColors: string[]
  setSelectedColors: (value: string[]) => void
  availableColors: string[]

  onlyOffers: boolean
  setOnlyOffers: (value: boolean) => void

  onlyBestSellers: boolean
  setOnlyBestSellers: (value: boolean) => void
  onlyNew: boolean
  setOnlyNew: (value: boolean) => void

  minPrice: number
  setMinPrice: (value: number) => void
  maxPrice: number
  setMaxPrice: (value: number) => void
}

export function ProductsFiltersSidebar({
  selectedCategories,
  setSelectedCategories,
  selectedColors,
  setSelectedColors,
  availableColors,

  onlyOffers,
  setOnlyOffers,

  onlyBestSellers,
  setOnlyBestSellers,
  onlyNew,
  setOnlyNew,

  minPrice,
  setMinPrice,
  maxPrice,
  setMaxPrice,
}: ProductsFiltersSidebarProps) {
  const toggleColor = (color: string) => {
    if (selectedColors.includes(color)) {
      setSelectedColors(
        selectedColors.filter((item) => item !== color)
      )
      return
    }

    setSelectedColors([...selectedColors, color])
  }

  return (
    <aside className="h-fit rounded-2xl border border-white/7 bg-beyonix-surface overflow-hidden">

      {/* Encabezado del panel */}
      <div className="px-5 py-4 border-b border-white/7 flex items-center gap-2.5">
        {/* Acento de color de marca */}
        <span className="block h-4 w-3px rounded-full bg-beyonix-blue-light" />
        <h3 className="text-11px font-semibold uppercase tracking-widest text-white/60">
          Filtros
        </h3>
      </div>

      <div className="px-5 py-5 space-y-0 divide-y divide-white/5">

        <div className="pb-6">
          <CommerceFilter
            onlyOffers={onlyOffers}
            setOnlyOffers={setOnlyOffers}
            onlyBestSellers={onlyBestSellers}
            setOnlyBestSellers={setOnlyBestSellers}
            onlyNew={onlyNew}
            setOnlyNew={setOnlyNew}
          />
        </div>

        <div className="py-6">
          <PriceFilter
            minPrice={minPrice}
            maxPrice={maxPrice}
            setMinPrice={setMinPrice}
            setMaxPrice={setMaxPrice}
          />
        </div>

        <div className="py-6">
          <CategoryFilter
            selectedCategories={selectedCategories}
            setSelectedCategories={setSelectedCategories}
          />
        </div>

        <div className="pt-6">
          <ColorFilter
            selectedColors={selectedColors}
            availableColors={availableColors}
            onToggleColor={toggleColor}
          />
        </div>

      </div>
    </aside>
  )
}