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

  showLabels?: boolean
}

export function ColorSelector({
  colors,
  selectedColor,
  onSelect,
  showLabels = false,
}: ColorSelectorProps) {
  if (colors.length <= 1 && !showLabels) {
    return null
  }

  return (
    <div className="custom-scrollbar flex h-full flex-wrap items-start gap-2 overflow-y-auto pr-1">
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
            onClick={() =>
              onSelect(
                value
              )
            }
            className={
              showLabels
                ? `relative flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-11px font-medium transition-all duration-200 ${
                    isSelected
                      ? "border-beyonix-sky bg-beyonix-blue text-white shadow-beyonix-color-selected"
                      : "border-white/10 bg-white/4 text-white/70 hover:border-beyonix-blue-light/45 hover:bg-white/7 hover:text-white"
                  }`
                : `relative flex size-7 cursor-pointer items-center justify-center rounded-full transition-all duration-200 ${
                    isSelected
                      ? "scale-110 ring-2 ring-white/60 ring-offset-2 ring-offset-black"
                      : "opacity-60 hover:scale-105 hover:opacity-100 hover:ring-1 hover:ring-white/25 hover:ring-offset-2 hover:ring-offset-black"
                  }`
            }
          >
            <span
              style={{
                backgroundColor:
                  color.colorHex ??
                  undefined,
                boxShadow:
                  "inset 0 0 0 1.5px rgba(255,255,255,0.2)",
              }}
              className={`block size-3.5 shrink-0 rounded-full ${colorClass}`}
            />
            {showLabels && <span>{color.name}</span>}
          </button>
        )
      })}
    </div>
  )
}
