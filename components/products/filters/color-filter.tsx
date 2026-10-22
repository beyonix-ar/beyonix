"use client"

import { productColors } from "@/lib/product-colors"
import { MULTICOLOR_FILTER, RANDOM_COLOR_FILTER } from "@/lib/products/catalog-filters"
import { RANDOM_COLOR_LABEL, RandomColorSwatch } from "@/components/products/random-color-swatch"

interface ColorFilterProps {
  selectedColors: string[]
  availableColors: string[]
  onToggleColor: (color: string) => void
}

const colorLabels: Record<string, string> = {
  negro: "Negro",
  blanco: "Blanco",
  gris: "Gris",
  azul: "Azul",
  rojo: "Rojo",
  amarillo: "Amarillo",
  verde: "Verde",
  rosa: "Rosa",
  violeta: "Violeta",
  beige: "Beige",
}

export function ColorFilter({
  selectedColors,
  availableColors,
  onToggleColor,
}: ColorFilterProps) {
  return (
    <div>
      <p className="mb-4 text-11px font-bold uppercase tracking-widest text-beyonix-sky/82">
        Colores
      </p>

      <div className="flex flex-wrap gap-3">
        {availableColors.filter((color) => color !== MULTICOLOR_FILTER && color !== RANDOM_COLOR_FILTER).map((colorKey) => {
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
              aria-label={`Filtrar por color ${colorLabels[colorKey] ?? colorKey}`}
              className={`beyonix-color-swatch relative size-7 rounded-full border shadow-[inset_0_0_0_2px_rgba(255,255,255,0.12)] transition-all duration-200 cursor-pointer ${colorClass} ${
                isSelected
                  ? "border-beyonix-cyan ring-2 ring-beyonix-cyan/60 ring-offset-2 ring-offset-[#071018] shadow-beyonix-color-selected"
                  : "border-white/20 hover:border-white/50 hover:scale-105"
              }`}
            />
          )
        })}
        {availableColors.includes(RANDOM_COLOR_FILTER) && (
          <button
            type="button"
            aria-label={RANDOM_COLOR_LABEL}
            title={RANDOM_COLOR_LABEL}
            aria-pressed={selectedColors.includes(RANDOM_COLOR_FILTER)}
            onClick={() => onToggleColor(RANDOM_COLOR_FILTER)}
            className={`beyonix-color-swatch relative size-7 cursor-pointer rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-cyan/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#071018] ${
              selectedColors.includes(RANDOM_COLOR_FILTER)
                ? "ring-2 ring-beyonix-cyan/60 ring-offset-2 ring-offset-[#071018] shadow-beyonix-color-selected"
                : "hover:scale-105"
            }`}
          >
            <RandomColorSwatch decorative className="size-full" />
          </button>
        )}
      </div>
      {availableColors.includes(MULTICOLOR_FILTER) && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-white/10 pt-3">
          <button type="button" aria-label="Filtrar por Multicolor" aria-pressed={selectedColors.includes(MULTICOLOR_FILTER)} onClick={() => onToggleColor(MULTICOLOR_FILTER)} className={`flex items-center gap-2 rounded-full border px-2.5 py-1.5 text-xs transition-colors ${selectedColors.includes(MULTICOLOR_FILTER) ? "border-beyonix-cyan text-white" : "border-white/20 text-white/70 hover:border-white/50"}`}>
            <span className="size-4 rounded-full bg-[conic-gradient(#4868b5,#bd6b9d,#a6b76b,#4868b5)]" aria-hidden="true" />
            Multicolor
          </button>
        </div>
      )}
    </div>
  )
}
