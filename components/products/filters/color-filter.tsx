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
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">
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
                  ? "border-[#4A90B8] ring-2 ring-[#4A90B8]/60 ring-offset-2 ring-offset-black shadow-[0_0_10px_rgba(74,144,184,0.3)]"
                  : "border-white/20 hover:border-white/50 hover:scale-105"
              }`}
            />
          )
        })}
      </div>
    </div>
  )
}