"use client"

import { useState } from "react"
import { SlidersHorizontal } from "lucide-react"

import { CommerceFilter } from "./filters/commerce-filter"
import { PriceFilter } from "./filters/price-filter"
import { CategoryFilter } from "./filters/category-filter"
import { ColorFilter } from "./filters/color-filter"
import type { SupabaseCategoria } from "@/lib/supabase/types"

interface ProductsFiltersSidebarProps {
  categories: SupabaseCategoria[]
  selectedCategories: string[]
  setSelectedCategories: (value: string[]) => void
  selectedColors?: string[]
  availableColors?: string[]
  setSelectedColors?: (value: string[]) => void

  onlyOffers: boolean
  setOnlyOffers: (value: boolean) => void

  onlyBestSellers: boolean
  setOnlyBestSellers: (value: boolean) => void
  onlyInstallments: boolean
  setOnlyInstallments: (value: boolean) => void

  showInstallmentsFilter: boolean
  showFeaturedFilter: boolean
  showOfferFilter: boolean
  showPriceFilter: boolean
  showCategoryFilter: boolean

  minPrice: number
  setMinPrice: (value: number) => void
  maxPrice: number
  setMaxPrice: (value: number) => void
  minPriceLimit: number
  maxPriceLimit: number
  priceStep: number
}

export function ProductsFiltersSidebar({
  categories,
  selectedCategories,
  setSelectedCategories,
  selectedColors = [],
  availableColors = [],
  setSelectedColors,

  onlyOffers,
  setOnlyOffers,

  onlyBestSellers,
  setOnlyBestSellers,
  onlyInstallments,
  setOnlyInstallments,

  showInstallmentsFilter,
  showFeaturedFilter,
  showOfferFilter,
  showPriceFilter,
  showCategoryFilter,

  minPrice,
  setMinPrice,
  maxPrice,
  setMaxPrice,
  minPriceLimit,
  maxPriceLimit,
  priceStep,
}: ProductsFiltersSidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <aside className="h-fit overflow-hidden rounded-xl border border-white/7 bg-beyonix-surface">

      {/* Encabezado del panel */}
      <button
        type="button"
        aria-label="Mostrar u ocultar filtros"
        title="Mostrar u ocultar filtros"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((current) => !current)}
        className="flex min-h-44px w-full cursor-pointer items-center justify-between gap-3 border-b border-white/7 px-4 py-3 text-left lg:hidden"
      >
        <span className="flex items-center gap-2.5">
          <span className="block h-4 w-3px rounded-full bg-beyonix-blue-light" />
          <span className="text-11px font-semibold uppercase tracking-widest text-white/60">
            Filtros
          </span>
        </span>

        <SlidersHorizontal className="size-4 text-beyonix-sky/80" />
      </button>

      <div className="hidden items-center gap-2.5 border-b border-white/7 px-4 py-3.5 lg:flex">
        {/* Acento de color de marca */}
        <span className="block h-4 w-3px rounded-full bg-beyonix-blue-light" />
        <h3 className="text-11px font-semibold uppercase tracking-widest text-white/60">
          Filtros
        </h3>
      </div>

      <div
        className={`space-y-0 divide-y divide-white/5 px-4 py-4 lg:block ${
          mobileOpen ? "block" : "hidden"
        }`}
      >

        {(showOfferFilter ||
          showFeaturedFilter ||
          showInstallmentsFilter) && (
        <div className="pb-5">
          <CommerceFilter
            onlyOffers={onlyOffers}
            setOnlyOffers={setOnlyOffers}
            onlyBestSellers={onlyBestSellers}
            setOnlyBestSellers={setOnlyBestSellers}
            onlyInstallments={onlyInstallments}
            setOnlyInstallments={setOnlyInstallments}
            showOfferFilter={showOfferFilter}
            showFeaturedFilter={showFeaturedFilter}
            showInstallmentsFilter={showInstallmentsFilter}
          />
        </div>
        )}

        {showPriceFilter && (
        <div className="py-5">
          <PriceFilter
            minPrice={minPrice}
            maxPrice={maxPrice}
            minLimit={minPriceLimit}
            maxLimit={maxPriceLimit}
            step={priceStep}
            setMinPrice={setMinPrice}
            setMaxPrice={setMaxPrice}
          />
        </div>
        )}

        {showCategoryFilter && (
        <div className="py-5">
          <CategoryFilter
            categories={categories}
            selectedCategories={selectedCategories}
            setSelectedCategories={setSelectedCategories}
          />
        </div>
        )}

        {setSelectedColors && availableColors.length > 0 && (
        <div className="py-5">
          <ColorFilter
            selectedColors={selectedColors}
            availableColors={availableColors}
            onToggleColor={(color) => {
              setSelectedColors(
                selectedColors.includes(color)
                  ? selectedColors.filter((current) => current !== color)
                  : [...selectedColors, color]
              )
            }}
          />
        </div>
        )}

      </div>
    </aside>
  )
}
