"use client"

import { useState, useRef, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ChevronDown,
  Menu,
  ShoppingBag,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { AccountMenu } from "@/components/account-menu"
import { BeyonixHeaderLoginLink, BeyonixHeaderRegisterLink } from "@/components/beyonix-ui"
import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { CustomerNotificationsBell } from "@/components/customer-notifications-bell"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"
import { AccountThemeToggle } from "@/components/account/account-theme-toggle"
import { useCart } from "@/context/cart-context"
import { useAuth } from "@/context/auth-context"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import { lockDocumentScroll } from "@/lib/admin/scroll-lock"
import { getStoreCategorias } from "@/lib/supabase/queries/store"
import type { SupabaseCategoria } from "@/lib/supabase/types"
import { beyonixHoverBorder, cn } from "@/lib/utils"

export function SiteHeader() {
  const pathname = usePathname()
  const { cart, total, openCart } = useCart()
  const { user, isLoading, isInternal } = useAuth()
  const adminNotifications = useOrderNotifications(isInternal)

  const [categories, setCategories] = useState<SupabaseCategoria[]>([])
  const [catOpen, setCatOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  // Cuenta en mobile: estado propio (no comparte `userOpen` con el menú de
  // desktop, que vive oculto en el DOM y lo cerraría con su click-afuera).
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false)
  const [unreadNotifications, setUnreadNotifications] = useState(0)

  const catRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  // Un solo menú/panel del header abierto a la vez (cada apertura cierra los
  // demás) y, mientras haya uno, la página de fondo no scrollea.
  const anyOverlayOpen =
    catOpen || userOpen || notificationsOpen || mobileOpen || mobileAccountOpen

  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0)
  // Ingreso/registro vuelven a la página donde estaba el cliente (p. ej. el
  // producto), no siempre al inicio. getSafeRedirect valida el destino.
  const authRedirect =
    pathname && pathname !== "/" && !pathname.startsWith("/login")
      ? `redirect=${encodeURIComponent(pathname)}`
      : ""
  const loginHref = authRedirect ? `/login?${authRedirect}` : "/login"
  const registerHref = `/login?mode=register${authRedirect ? `&${authRedirect}` : ""}`
  const navLinkClass =
    "beyonix-site-header-nav-link relative -mx-2.5 inline-flex h-9 items-center justify-center rounded-md px-2.5 text-15px font-medium leading-none text-[#F8FAFC]/88 outline-none transition-colors duration-200 after:absolute after:bottom-1 after:left-1/2 after:h-px after:w-[calc(100%-1.25rem)] after:-translate-x-1/2 after:origin-center after:scale-x-0 after:bg-[rgba(125,204,255,0.72)] after:opacity-0 after:transition-all after:duration-300 after:ease-out hover:text-white hover:after:scale-x-100 hover:after:opacity-100 focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
  const navLinkActiveClass =
    "text-white after:scale-x-100 after:opacity-100"
  useEffect(() => {
    let active = true

    async function loadCategories() {
      try {
        const data = await getStoreCategorias()

        if (active) {
          setCategories(data)
        }
      } catch (error) {
        console.error("Error cargando categorías del navbar:", error)
      }
    }

    loadCategories()

    return () => {
      active = false
    }
  }, [])

  // Categorías (desktop): tap/click afuera o Escape cierran. Los listeners
  // sólo existen mientras el desplegable está abierto.
  useEffect(() => {
    if (!catOpen) return

    function handleOutside(e: PointerEvent) {
      if (catRef.current && !catRef.current.contains(e.target as Node)) {
        setCatOpen(false)
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setCatOpen(false)
    }

    document.addEventListener("pointerdown", handleOutside)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("pointerdown", handleOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [catOpen])

  // Menú general (mobile): tap afuera del header o Escape cierran; Escape
  // devuelve el foco al botón del menú.
  useEffect(() => {
    if (!mobileOpen) return

    function handleOutside(e: PointerEvent) {
      if (headerRef.current?.contains(e.target as Node)) return
      setMobileOpen(false)
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      setMobileOpen(false)
      menuButtonRef.current?.focus()
    }

    document.addEventListener("pointerdown", handleOutside)
    document.addEventListener("keydown", handleEscape)
    return () => {
      document.removeEventListener("pointerdown", handleOutside)
      document.removeEventListener("keydown", handleEscape)
    }
  }, [mobileOpen])

  // Al pasar a desktop se cierran los paneles mobile (un listener de
  // breakpoint, no de cada resize).
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)")
    function handleChange(e: MediaQueryListEvent) {
      if (!e.matches) return
      setMobileOpen(false)
      setMobileAccountOpen(false)
    }

    desktop.addEventListener("change", handleChange)
    return () => desktop.removeEventListener("change", handleChange)
  }, [])

  useEffect(() => {
    if (!user) {
      setNotificationsOpen(false)
      setMobileAccountOpen(false)
    }
  }, [user])

  // Con cualquier menú/panel del header abierto el único scroll es el del
  // panel; al cerrar, la página vuelve exactamente a donde estaba.
  useEffect(() => {
    if (!anyOverlayOpen) return
    return lockDocumentScroll({ preventTouchScroll: true })
  }, [anyOverlayOpen])

  return (
    <header
      ref={headerRef}
      className={cn(
        "beyonix-site-header fixed top-0 left-0 right-0 z-50 border-b border-beyonix-blue-light/18 shadow-[0_8px_30px_rgba(0,0,0,0.38)]",
        // Abierto, barra y menú forman un panel sólido sobre la página.
        mobileOpen ? "bg-beyonix-surface-2" : "bg-black/78 backdrop-blur-xl"
      )}
    >
      <nav className="container mx-auto px-4 lg:px-8">
        <div className="grid h-16 grid-cols-[minmax(0,1fr)_auto] items-center lg:h-18 lg:grid-cols-site-header">
          <BeyonixLogoLink />

          <div className="hidden items-center justify-center gap-7 lg:flex">
            <Link
              href="/"
              className={cn(
                navLinkClass,
                pathname === "/" && navLinkActiveClass
              )}
            >
              Inicio
            </Link>

            <Link
              href="/productos"
              className={cn(
                navLinkClass,
                pathname.startsWith("/productos") && navLinkActiveClass
              )}
            >
              Productos
            </Link>

            <div ref={catRef} className="relative">
              <button
                type="button"
                aria-label="Abrir categorías"
                aria-expanded={catOpen}
                onClick={() => {
                  setCatOpen((v) => !v)
                  setNotificationsOpen(false)
                  setUserOpen(false)
                }}
                className={cn(
                  navLinkClass,
                  "cursor-pointer gap-1.5",
                  (catOpen || pathname.startsWith("/categorias")) &&
                    navLinkActiveClass
                )}
              >
                Categorías
                <ChevronDown
                  className={`size-3.5 transition-transform duration-200 ${
                    catOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {catOpen && (
                <div className="beyonix-site-header-panel absolute left-0 z-50 mt-3 w-52 overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] shadow-[0_18px_45px_rgba(0,0,0,0.45)]">
                  {categories.map((category, i) => (
                    <Link
                      key={category.id}
                      href={`/categorias/${category.slug}`}
                      onClick={() => setCatOpen(false)}
                      className={`beyonix-site-header-panel-item block px-4 py-3 text-sm text-[#F8FAFC] transition-all duration-200 hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF] hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)] ${
                        i < categories.length - 1
                          ? "border-b border-white/8"
                          : ""
                      }`}
                    >
                      {category.nombre}
                    </Link>
                  ))}
                  {!categories.length && (
                    <p className="beyonix-modal-muted px-4 py-3 text-sm text-white/45">
                      No hay categor&iacute;as disponibles.
                    </p>
                  )}
                  <Link
                    href="/categorias"
                    onClick={() => setCatOpen(false)}
                    className="beyonix-site-header-panel-item flex items-center gap-2 border-t border-white/8 px-4 py-3 text-sm font-semibold text-[#F8FAFC] transition-all duration-200 hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF] hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)]"
                  >
                    Ver todas →
                  </Link>
                </div>
              )}
            </div>

            <Link
              href="/contacto"
              className={cn(
                navLinkClass,
                pathname === "/contacto" && navLinkActiveClass
              )}
            >
              Contacto
            </Link>
          </div>

          <div className="beyonix-site-header-actions flex items-center justify-end gap-1 min-[400px]:gap-1.5 lg:gap-2">
            {user &&
              (isInternal ? (
                // Mobile: el panel administrador está en el menú de cuenta.
                <div className="hidden lg:block">
                  <AdminNotificationsBell
                    variant="storefront"
                    count={adminNotifications.notificationCount}
                    tone={adminNotifications.notificationTone}
                    groups={adminNotifications.notificationGroups}
                    notifications={adminNotifications.notifications}
                    loading={adminNotifications.loading}
                    error={adminNotifications.error}
                    onRetry={adminNotifications.reloadNotificationCount}
                  />
                </div>
              ) : (
                <CustomerNotificationsBell
                  userId={user.id}
                  open={notificationsOpen}
                  hideTriggerBelowLg
                  onOpenChange={(nextOpen) => {
                    setNotificationsOpen(nextOpen)

                    if (nextOpen) {
                      setCatOpen(false)
                      setUserOpen(false)
                      setMobileOpen(false)
                      setMobileAccountOpen(false)
                    }
                  }}
                  onUnreadCountChange={setUnreadNotifications}
                />
              ))}

            <AccountThemeToggle />

            <div className="relative hidden lg:block">
              {isLoading ? (
                <div
                  aria-hidden="true"
                  className="flex h-11 w-36 items-center gap-2 rounded-full border border-white/8 bg-white/5 px-3"
                >
                  <span className="size-7 shrink-0 animate-pulse rounded-full bg-white/10" />
                  <span className="h-2.5 w-16 animate-pulse rounded-full bg-white/10" />
                </div>
              ) : user ? (
                <AccountMenu
                  open={userOpen}
                  onOpenChange={(next) => {
                    setUserOpen(next)
                    if (next) {
                      setNotificationsOpen(false)
                      setCatOpen(false)
                    }
                  }}
                  onNotificationsClick={
                    isInternal
                      ? undefined
                      : () => {
                          setUserOpen(false)
                          setCatOpen(false)
                          setNotificationsOpen(true)
                        }
                  }
                  unreadNotificationsCount={unreadNotifications}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <BeyonixHeaderLoginLink href={loginHref} />
                  <BeyonixHeaderRegisterLink href={registerHref} />
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={openCart}
              aria-label="Abrir carrito"
              className={cn(
                "beyonix-site-header-cart-button relative flex h-11 cursor-pointer items-center gap-2 rounded-full bg-beyonix-blue/10 px-3 text-white hover:bg-beyonix-blue/18 max-sm:w-11 max-sm:justify-center max-sm:px-0",
                beyonixHoverBorder
              )}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-black">
                <ShoppingBag className="size-3.5" />
              </span>

              <span className="beyonix-site-header-cart-total hidden max-w-24 truncate text-sm font-semibold tabular-nums text-white sm:block">
                {total.toLocaleString("es-AR", {
                  style: "currency",
                  currency: "ARS",
                  minimumFractionDigits: 0,
                })}
              </span>

              {itemCount > 0 && (
                <Badge className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-beyonix-blue-light bg-beyonix-blue p-0 text-10px font-bold text-white">
                  {itemCount}
                </Badge>
              )}
            </button>

            {user && (
              <AccountMenu
                compact
                className="lg:hidden"
                open={mobileAccountOpen}
                onOpenChange={(next) => {
                  setMobileAccountOpen(next)
                  if (next) {
                    setMobileOpen(false)
                    setNotificationsOpen(false)
                    setCatOpen(false)
                  }
                }}
                onNotificationsClick={
                  isInternal
                    ? undefined
                    : () => {
                        setMobileAccountOpen(false)
                        setNotificationsOpen(true)
                      }
                }
                unreadNotificationsCount={unreadNotifications}
              />
            )}

            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => {
                setMobileOpen((v) => !v)
                setNotificationsOpen(false)
                setCatOpen(false)
                setUserOpen(false)
                setMobileAccountOpen(false)
              }}
              aria-label={mobileOpen ? "Cerrar menú" : "Abrir menú"}
              aria-expanded={mobileOpen}
              aria-controls={mobileOpen ? "beyonix-mobile-menu" : undefined}
              className="beyonix-site-header-menu-button flex size-11 cursor-pointer items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/8 hover:text-white lg:hidden"
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div
            id="beyonix-mobile-menu"
            data-mobile-menu
            className="max-h-80vh space-y-1 overflow-y-auto overscroll-contain border-t border-white/6 py-3 lg:hidden"
          >
            {[
              { label: "Inicio", href: "/" },
              { label: "Productos", href: "/productos" },
              { label: "Categorías", href: "/categorias" },
              { label: "Contacto", href: "/contacto" },
            ].map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "beyonix-site-header-nav-link relative block px-2 py-3 text-15px font-medium text-[#F8FAFC]/88 transition-colors duration-200 after:absolute after:bottom-1.5 after:left-2 after:h-px after:w-10 after:origin-left after:scale-x-0 after:bg-[rgba(125,204,255,0.72)] after:opacity-0 after:transition-all after:duration-300 after:ease-out hover:text-white hover:after:scale-x-100 hover:after:opacity-100",
                  (link.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(link.href)) &&
                    "text-white after:scale-x-100 after:opacity-100"
                )}
              >
                {link.label}
              </Link>
            ))}

            {/* La cuenta (logueado) vive en su propio botón de la barra. */}
            {!user && (
              <div className="mt-2 border-t border-white/6 pt-2">
                {isLoading ? (
                  <div
                    className="grid gap-2 px-2 py-3 sm:grid-cols-2"
                    aria-hidden="true"
                  >
                    <div className="h-10 animate-pulse rounded-lg bg-white/5" />
                    <div className="h-10 animate-pulse rounded-lg bg-white/5" />
                  </div>
                ) : (
                  <div className="grid gap-2 px-2 py-3 sm:grid-cols-2">
                    <Link
                      href={loginHref}
                      onClick={() => setMobileOpen(false)}
                      className="beyonix-modal-body flex h-10 items-center justify-center rounded-lg border border-beyonix-blue-light/22 bg-white/4 text-sm font-semibold text-white/84 transition hover:border-beyonix-blue-light/45 hover:text-white"
                    >
                      Iniciar sesión
                    </Link>
                    <Link
                      href={registerHref}
                      onClick={() => setMobileOpen(false)}
                      className="flex h-10 items-center justify-center rounded-lg border border-beyonix-blue-light/45 bg-beyonix-blue text-sm font-semibold text-white transition hover:border-beyonix-blue-light/75 hover:bg-beyonix-blue-hover"
                    >
                      Registrarse
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </nav>
    </header>
  )
}
