"use client"

import { productColors } from "@/lib/product-colors"

interface ColorOption {
  name: string
  value: keyof typeof productColors
}

interface ColorSelectorProps {
  colors: ColorOption[]
  selectedColor: string
  onSelect: (colorName: string) => void
}

export function ColorSelector({
  colors,
  selectedColor,
  onSelect,
}: ColorSelectorProps) {
  return (
    <div className="flex items-center gap-3">
      {colors.map((color) => {
        const isSelected = selectedColor === color.name
        const swatchClass = productColors[color.value]

        return (
          <button
            key={color.name}
            onClick={() => onSelect(color.name)}
            aria-label={color.name}
            className={`relative flex items-center justify-center size-7 rounded-full transition-all duration-200 cursor-pointer ${
              isSelected
                ? "ring-2 ring-white/60 ring-offset-[3px] ring-offset-[#0a0a0a] scale-110"
                : "opacity-60 hover:opacity-100 hover:scale-105 hover:ring-1 hover:ring-white/25 hover:ring-offset-[2px] hover:ring-offset-[#0a0a0a]"
            }`}
          >
            <span
              className={`block size-5 rounded-full ${swatchClass}`}
              style={{ boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.2)" }}
            />
          </button>
        )
      })}
    </div>
  )
}