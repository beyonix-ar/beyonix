"use client"

import { Moon, Sun } from "lucide-react"

import { useAccountTheme } from "@/context/account-theme-context"
import { cn } from "@/lib/utils"

export function AccountThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useAccountTheme()
  const isLight = theme === "light"

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isLight ? "Cambiar a modo oscuro" : "Cambiar a modo claro"}
      title={isLight ? "Modo oscuro" : "Modo claro"}
      className={cn(
        "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[#303846] bg-[#0D1117] text-white/80 transition-all hover:border-beyonix-blue-light hover:bg-[#141820] hover:text-white",
        "[html[data-account-scope]_&]:border-[var(--account-border)] [html[data-account-scope]_&]:bg-[var(--account-surface-raised)] [html[data-account-scope]_&]:text-[var(--account-text-secondary)] [html[data-account-scope]_&]:hover:border-[var(--account-border-strong)] [html[data-account-scope]_&]:hover:bg-[var(--account-surface-hover)] [html[data-account-scope]_&]:hover:text-[var(--account-text-primary)]",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[var(--account-focus-ring)]",
        className,
      )}
    >
      {isLight ? (
        <Moon className="size-4.5" aria-hidden="true" />
      ) : (
        <Sun className="size-4.5" aria-hidden="true" />
      )}
    </button>
  )
}
