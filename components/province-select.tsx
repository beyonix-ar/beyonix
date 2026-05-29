import { ChevronDown } from "lucide-react"

import { ARGENTINA_PROVINCES } from "@/lib/validation/account-fields"

export function ProvinceSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-12 w-full appearance-none rounded-xl border border-white/10 bg-black px-4 pr-10 text-sm text-white outline-none transition-colors hover:border-white/18 focus:border-beyonix-focus"
        required
      >
        <option value="">Seleccioná una provincia</option>
        {ARGENTINA_PROVINCES.map((province) => (
          <option key={province} value={province}>
            {province}
          </option>
        ))}
      </select>

      <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-white/45" />
    </div>
  )
}
