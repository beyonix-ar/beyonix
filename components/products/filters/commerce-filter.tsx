"use client"

interface CommerceFilterProps {
  onlyOffers: boolean
  setOnlyOffers: (value: boolean) => void
  onlyBestSellers: boolean
  setOnlyBestSellers: (value: boolean) => void
  onlyInstallments: boolean
  setOnlyInstallments: (value: boolean) => void
  showOfferFilter: boolean
  showFeaturedFilter: boolean
  showInstallmentsFilter: boolean
}

const options = [
  { label: "En oferta", key: "offers", visibleKey: "showOfferFilter" },
  { label: "Destacados", key: "featured", visibleKey: "showFeaturedFilter" },
  {
    label: "Cuotas sin interes",
    key: "installments",
    visibleKey: "showInstallmentsFilter",
  },
] as const

export function CommerceFilter({
  onlyOffers,
  setOnlyOffers,
  onlyBestSellers,
  setOnlyBestSellers,
  onlyInstallments,
  setOnlyInstallments,
  showOfferFilter,
  showFeaturedFilter,
  showInstallmentsFilter,
}: CommerceFilterProps) {
  const checkedMap: Record<string, boolean> = {
    offers: onlyOffers,
    featured: onlyBestSellers,
    installments: onlyInstallments,
  }

  const setterMap: Record<string, (value: boolean) => void> = {
    offers: setOnlyOffers,
    featured: setOnlyBestSellers,
    installments: setOnlyInstallments,
  }

  const visibilityMap: Record<string, boolean> = {
    showOfferFilter,
    showFeaturedFilter,
    showInstallmentsFilter,
  }

  const visibleOptions = options.filter(
    (option) => visibilityMap[option.visibleKey]
  )

  if (!visibleOptions.length) {
    return null
  }

  return (
    <div>
      <p className="mb-4 text-11px font-semibold uppercase tracking-widest text-white/50">
        Estado comercial
      </p>

      <div className="space-y-2.5">
        {visibleOptions.map(({ label, key }) => {
          const isChecked = checkedMap[key]

          return (
            <label
              key={key}
              className="group flex cursor-pointer items-center gap-3"
            >
              <span
                className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all duration-150 ${
                  isChecked
                    ? "border-beyonix-blue-light bg-beyonix-blue"
                    : "border-white/20 bg-transparent group-hover:border-white/40"
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
                  onChange={(event) =>
                    setterMap[key]?.(event.target.checked)
                  }
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </span>

              <span
                className={`text-sm transition-colors duration-150 ${
                  isChecked
                    ? "text-white"
                    : "text-white/70 group-hover:text-white/80"
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
