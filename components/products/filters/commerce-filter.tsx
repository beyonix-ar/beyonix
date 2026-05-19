"use client"

interface CommerceFilterProps {
  onlyOffers: boolean
  setOnlyOffers: (value: boolean) => void
  onlyBestSellers: boolean
  setOnlyBestSellers: (value: boolean) => void
  onlyNew: boolean
  setOnlyNew: (value: boolean) => void
}

const options = [
  { label: "En oferta", key: "offers" },
  { label: "Cuotas sin interés", key: "installments" },
  { label: "Más vendidos", key: "bestsellers" },
  { label: "Nuevos ingresos", key: "new" },
] as const

export function CommerceFilter({
  onlyOffers,
  setOnlyOffers,
  onlyBestSellers,
  setOnlyBestSellers,
  onlyNew,
  setOnlyNew,
}: CommerceFilterProps) {
  const checkedMap: Record<string, boolean> = {
    offers: onlyOffers,
    installments: false,
    bestsellers: onlyBestSellers,
    new: onlyNew,
  }

  const setterMap: Record<string, (v: boolean) => void> = {
    offers: setOnlyOffers,
    bestsellers: setOnlyBestSellers,
    new: setOnlyNew,
    installments: () => {},
  }

  return (
    <div>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40">
        Estado comercial
      </p>

      <div className="space-y-2.5">
        {options.map(({ label, key }) => {
          const isChecked = checkedMap[key]
          return (
            <label
              key={key}
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
                  onChange={(e) => setterMap[key]?.(e.target.checked)}
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