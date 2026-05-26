"use client"

import { productColors } from "@/lib/product-colors"

interface ColorOption {
  name: string
  value: keyof typeof productColors
}

interface ColorSelectorProps {
  colors: ColorOption[]

  selectedColor: string

  onSelect: (
    colorName: string
  ) => void
}

export function ColorSelector({
  colors,
  selectedColor,
  onSelect,
}: ColorSelectorProps) {
  if (colors.length <= 1) {
    return null
  }

  return (
    <div className="flex items-center gap-3">
      {colors.map((color) => {
        const isSelected =
          selectedColor ===
          color.name

        return (
          <button
            key={color.name}
            type="button"
            aria-label={
              color.name
            }
            title={color.name}
            onClick={() =>
              onSelect(
                color.name
              )
            }
            className={`relative flex size-7 cursor-pointer items-center justify-center rounded-full transition-all duration-200 ${
              isSelected
                ? "scale-110 ring-2 ring-white/60 ring-offset-[3px] ring-offset-[#0a0a0a]"
                : "opacity-60 hover:scale-105 hover:opacity-100 hover:ring-1 hover:ring-white/25 hover:ring-offset-[2px] hover:ring-offset-[#0a0a0a]"
            }`}
          >
            <span
              style={{
                boxShadow:
                  "inset 0 0 0 1.5px rgba(255,255,255,0.2)",
              }}
              className={`block size-5 rounded-full ${
                productColors[
                  color.value
                ]
              }`}
            />
          </button>
        )
      })}
    </div>
  )
}