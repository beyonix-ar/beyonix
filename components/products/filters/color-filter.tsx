"use client"

import { productColors } from "@/lib/product-colors"

interface ColorFilterProps {
  selectedColors: string[]
  availableColors: string[]
  onToggleColor: (color: string) => void
}

export function ColorFilter({
  selectedColors,
  availableColors,
  onToggleColor,
}: ColorFilterProps) {
  return (
    <div>
      <p className="mb-4 text-11px font-semibold uppercase tracking-widest text-white/50">
        Colores
      </p>

      <div className="flex flex-wrap gap-3">
        {availableColors.map((colorKey) => {
          const colorClass =
            productColors[
              colorKey as keyof typeof productColors
            ] || "bg-gray-500"

          const isSelected = selectedColors.includes(colorKey)

          return (
            <button
              key={colorKey}
              type="button"
              onClick={() => onToggleColor(colorKey)}
              aria-label={`Color ${colorKey}`}
              title={colorKey.charAt(0).toUpperCase() + colorKey.slice(1)}
              className={`relative size-7 rounded-full border transition-all duration-200 cursor-pointer ${colorClass} ${
                isSelected
                  ? "border-beyonix-cyan ring-2 ring-beyonix-cyan/60 ring-offset-2 ring-offset-black shadow-beyonix-color-selected"
                  : "border-white/20 hover:border-white/50 hover:scale-105"
              }`}
            />
          )
        })}
      </div>
    </div>
  )
}