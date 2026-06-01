"use client"

import { useState, useRef, useEffect } from "react"
import Link from "next/link"
import {
  ChevronDown,
  LogOut,
  Menu,
  Package,
  ShoppingBag,
  User,
  CircleUserRound,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useCart } from "@/context/cart-context"
import { useAuth } from "@/context/auth-context"
import { getStoreCategorias } from "@/lib/supabase/queries/store"
import type { SupabaseCategoria } from "@/lib/supabase/types"

export function SiteHeader() {
  const { cart, total, openCart } = useCart()
  const { user, logout } = useAuth()

  const [categories, setCategories] = useState<SupabaseCategoria[]>([])
  const [catOpen, setCatOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const catRef = useRef<HTMLDivElement>(null)
  const userRef = useRef<HTMLDivElement>(null)

  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0)
  const userLabel =
    user?.username?.trim() ||
    user?.email?.split("@")[0] ||
    "Mi cuenta"

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

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/10 bg-black">
      <nav className="container mx-auto px-4 lg:px-8">
        <div className="grid h-16 grid-cols-site-header items-center lg:h-20">
          <Link
            href="/"
            className="shrink-0 font-heading text-26px font-bold uppercase tracking-tight text-white transition-colors hover:text-white/90 lg:text-28px"
          >
            BEYONIX
          </Link>

          <div className="hidden items-center justify-center gap-8 lg:flex">
            <Link
              href="/"
              className="text-sm font-medium text-white/78 transition-colors hover:text-white"
            >
              Inicio
            </Link>

            <Link
              href="/productos"
              className="text-sm font-medium text-white/78 transition-colors hover:text-white"
            >
              Productos
            </Link>

            <div ref={catRef} className="relative">
              <button
                type="button"
                aria-label="Abrir categorías"
                title="Abrir categorías"
                onClick={() => setCatOpen((v) => !v)}
                className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-white/78 transition-colors hover:text-white"
              >
                Categorías
                <ChevronDown
                  className={`size-3.5 transition-transform duration-200 ${
                    catOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {catOpen && (
                <div className="absolute left-0 z-50 mt-3 w-52 overflow-hidden rounded-lg border border-white/10 bg-beyonix-surface-2 shadow-2xl shadow-black/60">
                  {categories.map((category, i) => (
                    <Link
                      key={category.id}
                      href={`/categorias/${category.slug}`}
                      onClick={() => setCatOpen(false)}
                      className={`block px-4 py-3 text-sm text-white/75 transition-colors hover:bg-white/5 hover:text-white ${
                        i < categories.length - 1
                          ? "border-b border-white/6"
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
                    className="flex items-center gap-2 border-t border-white/6 px-4 py-3 text-sm font-semibold text-beyonix-cyan transition-colors hover:bg-white/5"
                  >
                    Ver todas →
                  </Link>
                </div>
              )}
            </div>

            <Link
              href="/#contacto"
              className="text-sm font-medium text-white/78 transition-colors hover:text-white"
            >
              Contacto
            </Link>
          </div>

          <div className="flex items-center justify-end gap-2">
            <div ref={userRef} className="relative hidden lg:block">
              {user ? (
                <>
                  <button
                    type="button"
                    aria-label="Abrir menú de usuario"
                    title="Abrir menú de usuario"
                    onClick={() => setUserOpen((v) => !v)}
                    className="flex h-11 cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/3 pl-1.5 pr-3 text-white transition-all hover:border-white/22 hover:bg-white/7"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/15 bg-white text-black shadow-sm shadow-black/40">
                      {user.avatarUrl ? (
                        <img
                          src={user.avatarUrl}
                          alt=""
                          className="size-full object-cover"
                        />
                      ) : (
                        <CircleUserRound className="size-5" />
                      )}
                    </span>
                    <span className="max-w-90px truncate text-sm font-medium uppercase text-white/86">
                      {userLabel.toUpperCase()}
                    </span>
                    <ChevronDown
                      className={`size-3 text-white/52 transition-transform duration-200 ${
                        userOpen ? "rotate-180" : ""
                      }`}
                    />
                  </button>

                  {userOpen && (
                    <div className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-lg border border-white/10 bg-beyonix-surface-2 shadow-2xl shadow-black/60">
                      <Link
                        href="/cuenta"
                        onClick={() => setUserOpen(false)}
                        className="flex items-center gap-2.5 border-b border-white/6 px-4 py-3 text-sm text-white/75 transition-colors hover:bg-white/5 hover:text-white"
                      >
                        <User className="size-3.5 shrink-0" />
                        Mi cuenta
                      </Link>
                      <Link
                        href="/cuenta?tab=ordenes"
                        onClick={() => setUserOpen(false)}
                        className="flex items-center gap-2.5 border-b border-white/6 px-4 py-3 text-sm text-white/75 transition-colors hover:bg-white/5 hover:text-white"
                      >
                        <Package className="size-3.5 shrink-0" />
                        Mis órdenes
                      </Link>
                      <button
                        type="button"
                        aria-label="Cerrar sesión"
                        title="Cerrar sesión"
                        onClick={() => {
                          logout()
                          setUserOpen(false)
                        }}
                        className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-sm text-white/75 transition-colors hover:bg-white/5 hover:text-white"
                      >
                        <LogOut className="size-3.5 shrink-0" />
                        Cerrar sesión
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <Link
                  href="/login?redirect=/cuenta"
                  className="flex h-10 items-center gap-2 rounded-full border border-white/10 px-3.5 text-sm font-medium text-white/72 transition-colors hover:border-white/20 hover:text-white"
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
              title="Abrir carrito"
              className="relative flex h-10 cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/3 px-3 text-white transition-all hover:border-white/22 hover:bg-white/7"
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
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Abrir menú"
              title="Abrir menú"
              className="flex size-10 cursor-pointer items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/8 hover:text-white lg:hidden"
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {mobileOpen && (
          <div className="space-y-1 border-t border-white/6 py-4 lg:hidden">
            {[
              { label: "Inicio", href: "/" },
              { label: "Productos", href: "/productos" },
              { label: "Categorías", href: "/categorias" },
              { label: "Contacto", href: "/#contacto" },
            ].map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="block px-2 py-3 text-sm font-medium text-white/80 transition-colors hover:text-white"
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
                    className="block px-2 py-2.5 text-sm font-medium text-white/62 transition-colors hover:text-white"
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
                    className="block px-2 py-3 text-sm font-medium text-white/80 transition-colors hover:text-white"
                  >
                    Mi cuenta ({userLabel.toUpperCase()})
                  </Link>
                  <button
                    type="button"
                    aria-label="Cerrar sesión"
                    title="Cerrar sesión"
                    onClick={() => {
                      logout()
                      setMobileOpen(false)
                    }}
                    className="block w-full cursor-pointer px-2 py-3 text-left text-sm font-medium text-white/60 transition-colors hover:text-white"
                  >
                    Cerrar sesión
                  </button>
                </>
              ) : (
                <Link
                  href="/login?redirect=/cuenta"
                  onClick={() => setMobileOpen(false)}
                  className="block px-2 py-3 text-sm font-medium text-beyonix-cyan transition-colors hover:text-white"
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
