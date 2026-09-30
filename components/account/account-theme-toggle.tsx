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
        // Mismo botón que la campana del header (.beyonix-header-icon-button
        // en globals.css): tamaño, borde, radio y colores en ambos temas.
        "beyonix-header-icon-button flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-all",
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
