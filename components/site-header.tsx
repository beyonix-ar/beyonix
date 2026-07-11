"use client"

import { useState, useRef, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  ChevronDown,
  CircleUserRound,
  Coins,
  Heart,
  IdCard,
  LockKeyhole,
  LogOut,
  Menu,
  ShieldCheck,
  ShoppingBag,
  User,
  X,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { CustomerNotificationsBell } from "@/components/customer-notifications-bell"
import { AdminNotificationsBell } from "@/components/admin-notifications-bell"
import { useCart } from "@/context/cart-context"
import { useAuth } from "@/context/auth-context"
import { useOrderNotifications } from "@/hooks/use-order-notifications"
import { getStoreCategorias } from "@/lib/supabase/queries/store"
import type { SupabaseCategoria } from "@/lib/supabase/types"
import { beyonixHoverBorder, cn } from "@/lib/utils"

function AccountMenuIcon({
  Icon,
  filled = false,
  dollarBadge = false,
}: {
  Icon: LucideIcon
  filled?: boolean
  dollarBadge?: boolean
}) {
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg border border-beyonix-blue-light/34 bg-[linear-gradient(135deg,rgba(17,42,67,0.86),rgba(7,18,31,0.9))] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_12px_rgba(30,140,255,0.1)] transition-all group-hover:border-beyonix-sky/58 group-hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.11),0_0_16px_rgba(140,200,242,0.16)]">
      <Icon
        className={`size-4 stroke-[2.35] drop-shadow-[0_0_4px_rgba(255,255,255,0.18)] ${
          filled ? "fill-white" : "fill-none"
        }`}
      />
      {dollarBadge && (
        <span className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-white/24 bg-white text-[9px] font-black leading-none text-[#07121E] shadow-[0_0_8px_rgba(255,255,255,0.14)]">
          $
        </span>
      )}
    </span>
  )
}

export function SiteHeader() {
  const pathname = usePathname()
  const { cart, total, openCart } = useCart()
  const { user, isLoading, isInternal, logout } = useAuth()
  const adminNotifications = useOrderNotifications(isInternal)

  const [categories, setCategories] = useState<SupabaseCategoria[]>([])
  const [catOpen, setCatOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const catRef = useRef<HTMLDivElement>(null)
  const userRef = useRef<HTMLDivElement>(null)

  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0)
  const userLabel =
    user?.username?.trim() ||
    (isLoading ? "" : "Mi cuenta")
  const navLinkClass =
    "relative -mx-2.5 inline-flex h-9 items-center justify-center rounded-md px-2.5 text-15px font-medium leading-none text-[#F8FAFC]/88 outline-none transition-colors duration-200 after:absolute after:bottom-1 after:left-1/2 after:h-px after:w-[calc(100%-1.25rem)] after:-translate-x-1/2 after:origin-center after:scale-x-0 after:bg-[rgba(125,204,255,0.72)] after:opacity-0 after:transition-all after:duration-300 after:ease-out hover:text-white hover:after:scale-x-100 hover:after:opacity-100 focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
  const navLinkActiveClass =
    "text-white after:scale-x-100 after:opacity-100"
  const accountMenuItemClass =
    "group flex items-center gap-2.5 border-b border-white/8 px-4 py-3 text-sm text-[#F8FAFC] outline-none transition-all duration-200 hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF] hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)] focus-visible:bg-[rgba(17,42,67,0.75)] focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
  const accountMenuIconClass =
    "size-4 shrink-0 text-white/84 transition-colors duration-200 group-hover:text-beyonix-sky"

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

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (catRef.current && !catRef.current.contains(e.target as Node)) {
        setCatOpen(false)
      }
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserOpen(false)
      }
    }

    document.addEventListener("mousedown", handleOutside)
    return () => document.removeEventListener("mousedown", handleOutside)
  }, [])

  useEffect(() => {
    function handleResize() {
      if (window.innerWidth >= 1024) setMobileOpen(false)
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  useEffect(() => {
    if (!user) setNotificationsOpen(false)
  }, [user])

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-beyonix-blue-light/18 bg-black/78 shadow-[0_8px_30px_rgba(0,0,0,0.38)] backdrop-blur-xl">
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
                <div className="absolute left-0 z-50 mt-3 w-52 overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] shadow-[0_18px_45px_rgba(0,0,0,0.45)]">
                  {categories.map((category, i) => (
                    <Link
                      key={category.id}
                      href={`/categorias/${category.slug}`}
                      onClick={() => setCatOpen(false)}
                      className={`block px-4 py-3 text-sm text-[#F8FAFC] transition-all duration-200 hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF] hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)] ${
                        i < categories.length - 1
                          ? "border-b border-white/8"
                          : ""
                      }`}
                    >
                      {category.nombre}
                    </Link>
                  ))}
                  {!categories.length && (
                    <p className="px-4 py-3 text-sm text-white/45">
                      No hay categor&iacute;as disponibles.
                    </p>
                  )}
                  <Link
                    href="/categorias"
                    onClick={() => setCatOpen(false)}
                    className="flex items-center gap-2 border-t border-white/8 px-4 py-3 text-sm font-semibold text-[#F8FAFC] transition-all duration-200 hover:bg-[rgba(17,42,67,0.75)] hover:text-[#D7ECFF] hover:shadow-[inset_0_0_0_1px_rgba(191,228,255,0.10)]"
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

          <div className="flex items-center justify-end gap-2">
            {user &&
              (isInternal ? (
                <AdminNotificationsBell
                  count={adminNotifications.notificationCount}
                  tone={adminNotifications.notificationTone}
                  groups={adminNotifications.notificationGroups}
                  notifications={adminNotifications.notifications}
                  loading={adminNotifications.loading}
                  error={adminNotifications.error}
                  onRetry={adminNotifications.reloadNotificationCount}
                />
              ) : (
                <CustomerNotificationsBell
                  userId={user.id}
                  open={notificationsOpen}
                  onOpenChange={(nextOpen) => {
                    setNotificationsOpen(nextOpen)

                    if (nextOpen) {
                      setCatOpen(false)
                      setUserOpen(false)
                      setMobileOpen(false)
                    }
                  }}
                />
              ))}

            <div ref={userRef} className="relative hidden lg:block">
              {user ? (
                <>
                  <button
                    type="button"
                    aria-label="Abrir menú de usuario"
                    onClick={() => {
                      setUserOpen((v) => !v)
                      setNotificationsOpen(false)
                      setCatOpen(false)
                    }}
                    className={cn(
                      "flex h-12 max-w-300px cursor-pointer items-center gap-2.5 rounded-full bg-beyonix-blue/10 pl-1.5 pr-3.5 text-white hover:bg-beyonix-blue/18",
                      beyonixHoverBorder,
                      userOpen &&
                        "border-beyonix-blue-light/70 ring-2 ring-beyonix-blue-light/18"
                    )}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-beyonix-blue-light/45 bg-white text-black shadow-sm shadow-black/40">
                      {user.avatarUrl ? (
                        <img
                          src={user.avatarUrl}
                          alt=""
                          className="size-full object-cover"
                        />
                      ) : (
                        <CircleUserRound className="size-6" />
                      )}
                    </span>
                    <span className="whitespace-nowrap text-sm font-medium uppercase text-white/86">
                      {userLabel.toUpperCase()}
                    </span>
                    <ChevronDown
                      className={`size-3 text-white/52 transition-transform duration-200 ${
                        userOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {userOpen && (
                    <div className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-xl border border-[rgba(148,197,255,0.18)] bg-[#080D14] shadow-[0_18px_45px_rgba(0,0,0,0.45)]">
                      <Link
                        href="/cuenta"
                        onClick={() => setUserOpen(false)}
                        className={accountMenuItemClass}
                      >
                        <AccountMenuIcon Icon={CircleUserRound} />
                        Mi cuenta
                      </Link>
                      <Link
                        href="/cuenta?tab=datos"
                        onClick={() => setUserOpen(false)}
                        className={accountMenuItemClass}
                      >
                        <AccountMenuIcon Icon={IdCard} />
                        Mis datos
                      </Link>
                      <Link
                        href="/cuenta?tab=ordenes"
                        onClick={() => setUserOpen(false)}
                        className={accountMenuItemClass}
                      >
                        <AccountMenuIcon Icon={Coins} dollarBadge />
                        Mis compras
                      </Link>
                      <Link
                        href="/cuenta/favoritos"
                        onClick={() => setUserOpen(false)}
                        className={accountMenuItemClass}
                      >
                        <AccountMenuIcon Icon={Heart} filled />
                        Favoritos
                      </Link>
                      <Link
                        href="/cuenta?tab=seguridad"
                        onClick={() => setUserOpen(false)}
                        className={accountMenuItemClass}
                      >
                        <AccountMenuIcon Icon={LockKeyhole} />
                        Seguridad
                      </Link>
                      {isInternal && (
                        <Link
                          href="/admin"
                          onClick={() => setUserOpen(false)}
                          className={`${accountMenuItemClass} font-semibold`}
                        >
                          <AccountMenuIcon Icon={ShieldCheck} />
                          Panel administrador
                        </Link>
                      )}
                      <button
                        type="button"
                        aria-label="Cerrar sesión"
                        onClick={() => {
                          logout()
                          setUserOpen(false)
                        }}
                        className="group flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-sm text-[#F8FAFC] outline-none transition-all duration-200 hover:bg-red-500/10 hover:text-red-300 hover:shadow-[inset_0_0_0_1px_rgba(248,113,113,0.14)] focus-visible:bg-red-500/10 focus-visible:text-red-300 focus-visible:ring-2 focus-visible:ring-red-400/25"
                      >
                        <LogOut className={accountMenuIconClass} strokeWidth={1.8} />
                        Cerrar sesión
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <Link
                  href="/login?redirect=/cuenta"
                  className={cn(
                    "flex h-10 cursor-pointer items-center gap-2 rounded-full px-3.5 text-sm font-medium text-white/72 hover:text-white",
                    beyonixHoverBorder
                  )}
                >
                  <User className="size-3.5" />
                  Iniciar sesión
                </Link>
              )}
            </div>

            <button
              type="button"
              onClick={openCart}
              aria-label="Abrir carrito"
              className={cn(
                "relative flex h-10 cursor-pointer items-center gap-2 rounded-full bg-beyonix-blue/10 px-3 text-white hover:bg-beyonix-blue/18",
                beyonixHoverBorder
              )}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-black">
                <ShoppingBag className="size-3.5" />
              </span>

              <span className="hidden max-w-24 truncate text-sm font-semibold tabular-nums text-white sm:block">
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

            <button
              type="button"
              onClick={() => {
                setMobileOpen((v) => !v)
                setNotificationsOpen(false)
                setCatOpen(false)
                setUserOpen(false)
              }}
              aria-label="Abrir menú"
              className="flex size-10 cursor-pointer items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/8 hover:text-white lg:hidden"
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="max-h-80vh space-y-1 overflow-y-auto border-t border-white/6 py-3 lg:hidden">
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
                  "relative block px-2 py-3 text-15px font-medium text-[#F8FAFC]/88 transition-colors duration-200 after:absolute after:bottom-1.5 after:left-2 after:h-px after:w-10 after:origin-left after:scale-x-0 after:bg-[rgba(125,204,255,0.72)] after:opacity-0 after:transition-all after:duration-300 after:ease-out hover:text-white hover:after:scale-x-100 hover:after:opacity-100",
                  (link.href === "/"
                    ? pathname === "/"
                    : pathname.startsWith(link.href)) &&
                    "text-white after:scale-x-100 after:opacity-100"
                )}
              >
                {link.label}
              </Link>
            ))}

            {categories.length > 0 && (
              <div className="border-t border-white/6 pt-2">
                {categories.map((category) => (
                  <Link
                    key={category.id}
                    href={`/categorias/${category.slug}`}
                    onClick={() => setMobileOpen(false)}
                    className="block rounded-lg border border-transparent px-2 py-2.5 text-15px font-medium text-[#F8FAFC] transition-all duration-200 hover:border-[rgba(140,200,242,0.12)] hover:bg-[rgba(17,42,67,0.18)] hover:text-white hover:shadow-[0_0_8px_rgba(96,165,250,0.08)]"
                  >
                    {category.nombre}
                  </Link>
                ))}
              </div>
            )}

            <div className="mt-2 border-t border-white/6 pt-2">
              {user ? (
                <>
                  <Link
                    href="/cuenta"
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2 py-3 text-15px font-medium text-white/80 hover:bg-white/4 hover:text-white",
                      beyonixHoverBorder
                    )}
                  >
                    <AccountMenuIcon Icon={CircleUserRound} />
                    Mi cuenta ({userLabel.toUpperCase()})
                  </Link>
                  <Link
                    href="/cuenta?tab=datos"
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2 py-3 text-15px font-medium text-white/80 hover:bg-white/4 hover:text-white",
                      beyonixHoverBorder
                    )}
                  >
                    <AccountMenuIcon Icon={IdCard} />
                    Mis datos
                  </Link>
                  <Link
                    href="/cuenta?tab=ordenes"
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2 py-3 text-15px font-medium text-white/80 hover:bg-white/4 hover:text-white",
                      beyonixHoverBorder
                    )}
                  >
                    <AccountMenuIcon Icon={Coins} dollarBadge />
                    Mis compras
                  </Link>
                  <Link
                    href="/cuenta/favoritos"
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2 py-3 text-15px font-medium text-white/80 hover:bg-white/4 hover:text-white",
                      beyonixHoverBorder
                    )}
                  >
                    <AccountMenuIcon Icon={Heart} filled />
                    Favoritos
                  </Link>
                  <Link
                    href="/cuenta?tab=seguridad"
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg px-2 py-3 text-15px font-medium text-white/80 hover:bg-white/4 hover:text-white",
                      beyonixHoverBorder
                    )}
                  >
                    <AccountMenuIcon Icon={LockKeyhole} />
                    Seguridad
                  </Link>
                  {isInternal && (
                    <Link
                      href="/admin"
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-lg px-2 py-3 text-15px font-semibold text-beyonix-cyan hover:bg-white/4 hover:text-white",
                        beyonixHoverBorder
                      )}
                    >
                      <AccountMenuIcon Icon={ShieldCheck} />
                      Panel administrador
                    </Link>
                  )}
                  <button
                    type="button"
                    aria-label="Cerrar sesión"
                    onClick={() => {
                      logout()
                      setMobileOpen(false)
                    }}
                    className="block w-full cursor-pointer px-2 py-3 text-left text-15px font-medium text-white/60 transition-colors hover:text-red-300"
                  >
                    Cerrar sesión
                  </button>
                </>
              ) : (
                <Link
                  href="/login?redirect=/cuenta"
                  onClick={() => setMobileOpen(false)}
                  className="block rounded-lg px-2 py-3 text-15px font-medium text-beyonix-cyan transition-colors hover:bg-white/4 hover:text-white"
                >
                  Iniciar sesión / Registrarse
                </Link>
              )}
            </div>
          </div>
        )}
      </nav>
    </header>
  )
}
