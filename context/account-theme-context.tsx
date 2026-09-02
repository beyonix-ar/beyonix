"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { usePathname } from "next/navigation"

import {
  ACCOUNT_THEME_STORAGE_KEY,
  DEFAULT_ACCOUNT_THEME,
  resolveAccountTheme,
  type AccountTheme,
} from "@/lib/account/account-theme"

const ACCOUNT_SCOPE_ATTRIBUTE = "data-account-scope"

/**
 * El toggle es ahora sitio-wide (Home, catálogo, PDP, checkout, /cuenta):
 * todo excepto /admin, que tiene su propio sistema de theme independiente
 * (AdminThemeProvider) y no debe mezclarse con este.
 */
function isAccountScopedRoute(pathname: string | null) {
  return Boolean(pathname && !pathname.startsWith("/admin"))
}

export type { AccountTheme }

interface AccountThemeContextValue {
  theme: AccountTheme
  setTheme: (theme: AccountTheme) => void
  toggleTheme: () => void
}

const AccountThemeContext = createContext<AccountThemeContextValue | null>(null)

function readStoredAccountTheme(): AccountTheme {
  if (typeof document === "undefined") return DEFAULT_ACCOUNT_THEME
  // El script de arranque en app/layout.tsx ya dejó este atributo listo
  // ANTES del primer paint (evita el flash), igual que data-admin-theme.
  return resolveAccountTheme(document.documentElement.getAttribute("data-account-theme"))
}

/**
 * Theme claro/oscuro del panel cliente -- mismo patrón que AdminThemeProvider
 * (context/admin-theme-context.tsx): el atributo vive en
 * document.documentElement (data-account-theme) para resolverse antes del
 * primer paint, y todas las reglas CSS que reaccionan a él están scopeadas
 * bajo html[data-account-theme="light"][data-account-scope] (ver
 * app/globals.css). Namespace propio (storage key y atributo separados de
 * Admin) para no acoplar ambos paneles entre sí.
 *
 * El scope se resuelve con un atributo en <html> (data-account-scope),
 * NUNCA con una clase en un <div> anidado del árbol de React -- contenido
 * "portaled" (createPortal(..., document.body), como el drawer del
 * carrito) se monta como hijo directo de document.body en el DOM real,
 * saltándose por completo cualquier <div> wrapper del árbol de React. Un
 * selector CSS descendiente sólo puede alcanzar ese contenido si el
 * ancestro marcado es, en el DOM real, un ancestro genuino de TODO --
 * <html> lo es siempre, sin importar dónde se haga el portal ni el timing
 * de parseo/hidratación (a diferencia de <body>, cuyo classList sólo puede
 * tocarse una vez existe en el DOM).
 *
 * El provider está montado en la raíz (app/layout.tsx) para que el toggle
 * y el estado estén disponibles en cualquier componente (header, dropdown),
 * pero data-account-scope sólo se activa dentro de /cuenta -- el resto del
 * storefront no se ve afectado. El valor inicial (antes del primer paint)
 * lo resuelve el script beforeInteractive en app/layout.tsx leyendo
 * window.location.pathname directamente; este efecto sólo lo mantiene
 * sincronizado en navegaciones client-side posteriores.
 */
export function AccountThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AccountTheme>(DEFAULT_ACCOUNT_THEME)
  const pathname = usePathname()

  useEffect(() => {
    setThemeState(readStoredAccountTheme())
  }, [])

  useEffect(() => {
    document.documentElement.toggleAttribute(ACCOUNT_SCOPE_ATTRIBUTE, isAccountScopedRoute(pathname))
  }, [pathname])

  const setTheme = useCallback((next: AccountTheme) => {
    setThemeState(next)
    try {
      window.localStorage.setItem(ACCOUNT_THEME_STORAGE_KEY, next)
    } catch {
      // localStorage puede fallar (modo privado, cuota, etc.) -- el theme
      // igual se aplica para esta sesión, sólo no persiste.
    }
    document.documentElement.setAttribute("data-account-theme", next)
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark")
  }, [theme, setTheme])

  return (
    <AccountThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </AccountThemeContext.Provider>
  )
}

export function useAccountTheme() {
  const context = useContext(AccountThemeContext)
  if (!context) {
    throw new Error("useAccountTheme debe usarse dentro de AccountThemeProvider")
  }
  return context
}
