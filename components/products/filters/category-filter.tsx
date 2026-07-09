"use client"

import type { SupabaseCategoria } from "@/lib/supabase/types"
import { ChevronRight, Cpu } from "lucide-react"

interface CategoryFilterProps {
  selectedCategories: string[]
  setSelectedCategories: (value: string[]) => void
  categories: SupabaseCategoria[]
}

export function CategoryFilter({
  selectedCategories,
  setSelectedCategories,
  categories,
}: CategoryFilterProps) {
  const toggleCategory = (category: string) => {
    if (selectedCategories.includes(category)) {
      setSelectedCategories(
        selectedCategories.filter((item) => item !== category)
      )
      return
    }

    setSelectedCategories([...selectedCategories, category])
  }

  return (
    <div>
      <p className="mb-4 text-11px font-bold uppercase tracking-widest text-beyonix-sky/82">
        Categorías
      </p>

      <div className="space-y-2.5">
        {categories.length === 0 && (
          <p className="text-sm text-white/45">
            No hay categor&iacute;as disponibles.
          </p>
        )}

        {categories.map(({ slug, nombre }) => {
          const isChecked = selectedCategories.includes(slug)
          return (
            <label
              key={slug}
              className="group flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5 transition-colors hover:bg-beyonix-blue/12"
            >
              {/* Checkbox personalizado */}
              <span
                className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all duration-150 ${
                  isChecked
                    ? "border-beyonix-sky bg-beyonix-blue shadow-[0_0_10px_rgba(56,189,248,0.28)]"
                    : "border-beyonix-blue-light/35 bg-black/20 group-hover:border-beyonix-sky/60"
                }`}
              >
                {isChecked && (
                  <svg
                    viewBox="0 0 10 8"
                    fill="none"
                    className="h-2.5 w-2.5 text-beyonix-cyan"
                  >
                    <path
                      d="M1 4l2.5 2.5L9 1"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleCategory(slug)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </span>

              <Cpu className="size-3.5 shrink-0 text-beyonix-cyan/65" />

              <span
                className={`text-sm transition-colors duration-150 ${
                  isChecked ? "text-white" : "text-white/66 group-hover:text-white/84"
                }`}
              >
                {nombre}
              </span>

              <ChevronRight className="ml-auto size-3.5 text-beyonix-cyan/45" />
            </label>
          )
        })}
      </div>
    </div>
  )
}
