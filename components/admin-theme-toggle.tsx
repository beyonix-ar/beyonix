"use client"

import { Moon, Sun } from "lucide-react"

import { useAdminTheme } from "@/context/admin-theme-context"

/**
 * Toggle de tema claro/oscuro del Admin. Control global -- vive en el
 * header/sidebar del panel (ver admin-client.tsx), no dentro de ninguna
 * pantalla puntual. 100% CSS-driven: cambiar el theme sólo actualiza un
 * atributo (data-admin-theme), no dispara ningún recálculo de datos ni
 * re-render de contenido.
 */
export function AdminThemeToggle() {
  const { theme, toggleTheme } = useAdminTheme()
  const isDark = theme === "dark"

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      // Mismo botón que la campana del panel en reposo
      // (admin-notification-bell.tsx): tamaño, radio, borde y colores en
      // ambos temas.
      className="admin-ds-bell-button-idle relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border text-white transition-all"
    >
      {isDark ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
    </button>
  )
}
