"use client"

import { useState } from "react"
import { Filter, SlidersHorizontal } from "lucide-react"

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
    <aside className="beyonix-filters-panel h-fit overflow-hidden rounded-xl">

      <button
        type="button"
        aria-label="Mostrar u ocultar filtros"
        title="Mostrar u ocultar filtros"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((current) => !current)}
        className="flex min-h-52px w-full cursor-pointer items-center justify-between gap-3 border-b border-beyonix-blue-light/18 px-4 py-3 text-left lg:hidden"
      >
        <span className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-md border border-beyonix-blue-light/22 bg-beyonix-blue/24 text-white">
            <Filter className="size-4" />
          </span>
          <span className="text-11px font-bold uppercase tracking-widest text-beyonix-sky">
            Filtrar productos
          </span>
        </span>

        <SlidersHorizontal className="size-4 text-beyonix-sky/80" />
      </button>

      <div className="hidden items-center gap-2.5 border-b border-beyonix-blue-light/18 px-4 py-4 lg:flex">
        <span className="flex size-9 items-center justify-center rounded-md border border-beyonix-blue-light/22 bg-beyonix-blue/24 text-white shadow-[0_0_8px_rgba(30,140,255,0.07)]">
          <Filter className="size-4" />
        </span>
        <h3 className="text-11px font-bold uppercase tracking-widest text-beyonix-sky">
          Filtrar productos
        </h3>
      </div>

      <div
        className={`space-y-0 divide-y divide-beyonix-blue-light/14 px-4 py-4 lg:block ${
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
