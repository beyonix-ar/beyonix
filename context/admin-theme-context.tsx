"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

import {
  ADMIN_THEME_STORAGE_KEY,
  DEFAULT_ADMIN_THEME,
  resolveAdminTheme,
  type AdminTheme,
} from "@/lib/admin/admin-theme"

export type { AdminTheme }

interface AdminThemeContextValue {
  theme: AdminTheme
  setTheme: (theme: AdminTheme) => void
  toggleTheme: () => void
}

const AdminThemeContext = createContext<AdminThemeContextValue | null>(null)

function readStoredAdminTheme(): AdminTheme {
  if (typeof document === "undefined") return DEFAULT_ADMIN_THEME
  // El script de arranque en app/layout.tsx ya dejó este atributo listo
  // ANTES del primer paint (evita el flash: no hay pantalla en un tema para
  // luego saltar a otro). Leerlo de acá en vez de localStorage de nuevo
  // garantiza que el estado inicial de React coincide exactamente con lo
  // que el usuario ya está viendo.
  return resolveAdminTheme(document.documentElement.getAttribute("data-admin-theme"))
}

/**
 * Theme claro/oscuro exclusivo del Admin -- el atributo vive en
 * document.documentElement (data-admin-theme) para poder resolverse antes
 * del primer paint (ver script en app/layout.tsx), pero todas las reglas
 * CSS que reaccionan a él están scopeadas bajo .beyonix-admin-shell (ver
 * app/globals.css), así que la tienda pública -- que nunca renderiza esa
 * clase -- no puede verse afectada aunque el atributo técnicamente exista
 * en <html> en cualquier página.
 */
export function AdminThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AdminTheme>(DEFAULT_ADMIN_THEME)

  useEffect(() => {
    setThemeState(readStoredAdminTheme())
  }, [])

  const setTheme = useCallback((next: AdminTheme) => {
    setThemeState(next)
    try {
      window.localStorage.setItem(ADMIN_THEME_STORAGE_KEY, next)
    } catch {
      // localStorage puede fallar (modo privado, cuota, etc.) -- el theme
      // igual se aplica para esta sesión, sólo no persiste.
    }
    document.documentElement.setAttribute("data-admin-theme", next)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark")
  }, [theme, setTheme])

  return (
    <AdminThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </AdminThemeContext.Provider>
  )
}

export function useAdminTheme() {
  const context = useContext(AdminThemeContext)
  if (!context) {
    throw new Error("useAdminTheme debe usarse dentro de AdminThemeProvider")
  }
  return context
}
