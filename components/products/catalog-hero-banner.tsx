import type { ReactNode } from "react"

import { StoreBenefits } from "./store-benefits"

export const CATALOG_HERO_IMAGE_CLASS = "absolute inset-0 z-0 size-full object-cover object-left"

interface CatalogHeroBannerProps {
  hasMedia: boolean
  media: ReactNode
  search: ReactNode
}

/** Misma caja, proporción y ubicación de buscador/beneficios en Productos y Categorías. */
export function CatalogHeroBanner({ hasMedia, media, search }: CatalogHeroBannerProps) {
  return (
    <div className="category-hero container relative z-20 mx-auto px-4 pb-8 pt-28 lg:px-8 lg:pb-10 lg:pt-32">
      <div className={`beyonix-hero-banner relative mx-auto flex w-full max-w-[var(--beyonix-content-max)] flex-col justify-end overflow-hidden rounded-xl border border-beyonix-blue-light/30 bg-[#03070D] text-center shadow-[0_0_42px_rgba(30,140,255,0.1),0_26px_70px_rgba(0,0,0,0.42)] ${hasMedia ? "lg:aspect-[1920/520] lg:min-h-[24rem]" : "pt-8 sm:pt-10 lg:pt-12"}`}>
        {hasMedia ? (
          <div data-banner-media className="relative aspect-[8000/2167] w-full shrink-0 lg:absolute lg:inset-0 lg:aspect-auto">
            {media}
          </div>
        ) : null}

        <div className={`relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center px-4 pb-8 sm:pb-10 ${hasMedia ? "pt-5 sm:pt-6 lg:pb-5 lg:pt-0" : "lg:pb-12"}`}>
          <div className="global-search-wrapper flex w-full justify-center">{search}</div>
          <StoreBenefits />
        </div>
      </div>
    </div>
  )
}
