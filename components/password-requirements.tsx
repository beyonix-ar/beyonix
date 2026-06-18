import { Check } from "lucide-react"

import { getPasswordRequirements } from "@/lib/validation/account-fields"

export function PasswordRequirements({ password }: { password: string }) {
  const requirements = getPasswordRequirements(password)

  return (
    <div className="mt-1.5 rounded-lg border border-white/10 bg-black/40 p-2.5">
      <p className="text-xs font-semibold text-white/70">
        Requisitos de contraseña:
      </p>
      <ul className="mt-1.5 grid gap-1 sm:grid-cols-2">
        {requirements.map((requirement) => (
          <li
            key={requirement.label}
            className={`flex items-center gap-1.5 text-xs transition-colors ${
              requirement.met ? "text-emerald-400" : "text-white/40"
            }`}
          >
            <Check className="size-3.5 shrink-0" strokeWidth={2.5} />
            <span>{requirement.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
