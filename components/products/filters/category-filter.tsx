"use client"

interface CategoryFilterProps {
  selectedCategories: string[]
  setSelectedCategories: (value: string[]) => void
}

const categories = [
  { slug: "audio-conectividad", label: "Audio y conectividad" },
  { slug: "confort-bienestar", label: "Confort y bienestar" },
  { slug: "setup-escritorio", label: "Setup y escritorio" },
]

export function CategoryFilter({
  selectedCategories,
  setSelectedCategories,
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
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">
        Categorías
      </p>

      <div className="space-y-2.5">
        {categories.map(({ slug, label }) => {
          const isChecked = selectedCategories.includes(slug)
          return (
            <label
              key={slug}
              className="flex items-center gap-3 cursor-pointer group"
            >
              {/* Checkbox personalizado */}
              <span
                className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all duration-150 ${
                  isChecked
                    ? "border-[#1E4D7B] bg-[#112A43]"
                    : "border-white/20 bg-transparent group-hover:border-white/40"
                }`}
              >
                {isChecked && (
                  <svg
                    viewBox="0 0 10 8"
                    fill="none"
                    className="h-2.5 w-2.5 text-[#4A90B8]"
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
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
              </span>

              <span
                className={`text-sm transition-colors duration-150 ${
                  isChecked ? "text-white" : "text-white/60 group-hover:text-white/80"
                }`}
              >
                {label}
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}