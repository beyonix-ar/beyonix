"use client"

import { CommerceFilter } from "./filters/commerce-filter"
import { PriceFilter } from "./filters/price-filter"
import { CategoryFilter } from "./filters/category-filter"
import type { SupabaseCategoria } from "@/lib/supabase/types"

interface ProductsFiltersSidebarProps {
  categories: SupabaseCategoria[]
  selectedCategories: string[]
  setSelectedCategories: (value: string[]) => void

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
}

export function ProductsFiltersSidebar({
  categories,
  selectedCategories,
  setSelectedCategories,

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
}: ProductsFiltersSidebarProps) {
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

        {(showOfferFilter ||
          showFeaturedFilter ||
          showInstallmentsFilter) && (
        <div className="pb-6">
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
        <div className="py-6">
          <PriceFilter
            minPrice={minPrice}
            maxPrice={maxPrice}
            setMinPrice={setMinPrice}
            setMaxPrice={setMaxPrice}
          />
        </div>
        )}

        {showCategoryFilter && (
        <div className="py-6">
          <CategoryFilter
            categories={categories}
            selectedCategories={selectedCategories}
            setSelectedCategories={setSelectedCategories}
          />
        </div>
        )}

      </div>
    </aside>
  )
}
