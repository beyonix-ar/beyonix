"use client"

import { productColors } from "@/lib/product-colors"

interface ProductColor {
  name: string
  value: string
}

interface ProductCardColorsProps {
  colors: ProductColor[]
  selectedIndex: number
  onSelectColor: (index: number) => void
}

export function ProductCardColors({
  colors,
  selectedIndex,
  onSelectColor,
}: ProductCardColorsProps) {
  if (!colors?.length) return null

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {colors.map((color, index) => (
        <button
          key={color.value}
          type="button"
          onClick={() => onSelectColor(index)}
          aria-label={`Color ${color.name}`}
          title={color.name.charAt(0).toUpperCase() + color.name.slice(1)}
          className={`size-5 rounded-full border transition-all duration-150 cursor-pointer hover:scale-110 ${
            productColors[
              color.value as keyof typeof productColors
            ] || "bg-white"
          } ${
            selectedIndex === index
              ? "border-beyonix-cyan ring-2 ring-beyonix-cyan/50 ring-offset-1 ring-offset-beyonix-surface"
              : "border-white/15 hover:border-white/40"
          }`}
        />
      ))}
    </div>
  )
}
