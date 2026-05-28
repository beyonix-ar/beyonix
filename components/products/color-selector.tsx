"use client"

import { productColors } from "@/lib/product-colors"

interface ColorOption {
  name: string
  value: string
  colorHex?: string | null
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
        const value = color.value || color.name
        const isSelected =
          selectedColor ===
            value ||
          selectedColor === color.name
        const colorClass =
          color.colorHex
            ? ""
            : productColors[
                color.value as keyof typeof productColors
              ] ?? "bg-white"

        return (
          <button
            key={value}
            type="button"
            aria-label={
              color.name
            }
            title={color.name}
            onClick={() =>
              onSelect(
                value
              )
            }
            className={`relative flex size-7 cursor-pointer items-center justify-center rounded-full transition-all duration-200 ${
              isSelected
                ? "scale-110 ring-2 ring-white/60 ring-offset-2 ring-offset-black"
                : "opacity-60 hover:scale-105 hover:opacity-100 hover:ring-1 hover:ring-white/25 hover:ring-offset-2 hover:ring-offset-black"
            }`}
          >
            <span
              style={{
                backgroundColor:
                  color.colorHex ??
                  undefined,
                boxShadow:
                  "inset 0 0 0 1.5px rgba(255,255,255,0.2)",
              }}
              className={`block size-5 rounded-full ${colorClass}`}
            />
          </button>
        )
      })}
    </div>
  )
}
