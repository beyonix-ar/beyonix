"use client"

import Image from "next/image"

import { productColors } from "@/lib/product-colors"
import { FALLBACK_PRODUCT_IMAGE } from "@/lib/products/product-variants"

interface ColorOption {
  name: string
  value: string
  colorHex?: string | null
  image?: string | null
}

interface ColorSelectorProps {
  colors: ColorOption[]

  selectedColor: string

  onSelect: (
    colorName: string
  ) => void

  showLabels?: boolean

  onPreviewChange?: (
    color: ColorOption | null
  ) => void

  // Reemplaza el chip de punto de color + texto por una miniatura cuadrada
  // con la primera imagen de la variante (usado en el modal de producto).
  // No afecta a los demás consumidores, que siguen usando el chip de color.
  thumbnailMode?: boolean
}

export function formatColorName(value: string) {
  return value
    .trim()
    .split(/([\s-]+)/)
    .map((part) => {
      if (!part || /^[\s-]+$/.test(part)) {
        return part
      }

      const [firstLetter, ...rest] = Array.from(
        part.toLocaleLowerCase("es-AR")
      )

      return `${firstLetter.toLocaleUpperCase("es-AR")}${rest.join("")}`
    })
    .join("")
}

export function ColorSelector({
  colors,
  selectedColor,
  onSelect,
  showLabels = false,
  onPreviewChange,
  thumbnailMode = false,
}: ColorSelectorProps) {
  if (colors.length <= 1 && !showLabels) {
    return null
  }

  return (
    <div className="custom-scrollbar flex h-full flex-wrap items-start gap-2.5 overflow-y-auto pr-1">
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
        const label = formatColorName(color.name)

        if (thumbnailMode) {
          return (
            <button
              key={value}
              type="button"
              aria-label={`Seleccionar color ${label}`}
              aria-pressed={isSelected}
              title={label}
              onClick={() => onSelect(value)}
              onMouseEnter={() => onPreviewChange?.(color)}
              onMouseLeave={() => onPreviewChange?.(null)}
              onFocus={() => onPreviewChange?.(color)}
              onBlur={() => onPreviewChange?.(null)}
              className={`relative size-12 shrink-0 cursor-pointer overflow-hidden rounded-xl bg-white transition-all duration-200 sm:size-14 ${
                isSelected
                  ? "border-2 border-[#112A43]"
                  : "border border-[#112A43]"
              }`}
            >
              <Image
                src={color.image || FALLBACK_PRODUCT_IMAGE}
                alt=""
                fill
                sizes="56px"
                className="object-cover"
              />
            </button>
          )
        }

        return (
          <button
            key={value}
            type="button"
            onClick={() =>
              onSelect(
                value
              )
            }
            onMouseEnter={() => onPreviewChange?.(color)}
            onMouseLeave={() => onPreviewChange?.(null)}
            onFocus={() => onPreviewChange?.(color)}
            onBlur={() => onPreviewChange?.(null)}
            className={
              showLabels
                ? `relative flex h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 text-13px font-semibold transition-all duration-200 ${
                    isSelected
                      ? "border-beyonix-blue-light/70 bg-[#102033] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                      : "border-white/12 bg-[#101418] text-white/78 hover:border-beyonix-blue-light/58 hover:bg-[#162337] hover:text-white"
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
              className={`block size-4 shrink-0 rounded-full ${colorClass}`}
            />
            {showLabels && <span>{label}</span>}
          </button>
        )
      })}
    </div>
  )
}
