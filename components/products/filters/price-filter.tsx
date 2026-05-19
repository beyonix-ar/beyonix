"use client"

import { Slider } from "@/components/ui/slider"

interface PriceFilterProps {
  minPrice: number
  maxPrice: number
  setMinPrice: (value: number) => void
  setMaxPrice: (value: number) => void
}

export function PriceFilter({
  minPrice,
  maxPrice,
  setMinPrice,
  setMaxPrice,
}: PriceFilterProps) {
  return (
    <div>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">
        Rango de precio
      </p>

      <Slider
        value={[minPrice, maxPrice]}
        min={1000}
        max={150000}
        step={1000}
        minStepsBetweenThumbs={1}
        onValueChange={(value) => {
          setMinPrice(value[0])
          setMaxPrice(value[1])
        }}
        className="w-full"
      />

      <div className="mt-3.5 flex justify-between">
        <span className="rounded-md bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/70">
          ${minPrice.toLocaleString("es-AR")}
        </span>
        <span className="rounded-md bg-white/[0.06] px-2.5 py-1 text-xs font-medium text-white/70">
          ${maxPrice.toLocaleString("es-AR")}
        </span>
      </div>
    </div>
  )
}