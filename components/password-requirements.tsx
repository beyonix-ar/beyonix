import { Check } from "lucide-react"

import { getPasswordRequirements } from "@/lib/validation/account-fields"

export function PasswordRequirements({ password }: { password: string }) {
  const requirements = getPasswordRequirements(password)

  return (
    <div className="mt-1.5 rounded-lg border border-beyonix-blue-light/30 bg-[var(--account-surface-highlight)] p-2 shadow-2xl shadow-black/70">
      <p className="text-xs font-semibold text-[var(--account-text-primary)]">
        Requisitos de contraseña:
      </p>
      <ul className="mt-1.5 grid gap-0.5 sm:grid-cols-2">
        {requirements.map((requirement) => (
          <li
            key={requirement.label}
            className={`flex items-center gap-1.5 text-xs transition-colors ${
              requirement.met
                ? "text-[var(--account-success-text)]"
                : "text-[var(--account-text-secondary)]"
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
