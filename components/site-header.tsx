"use client"

import { useState, useRef, useEffect } from "react"
import Link from "next/link"
import { ShoppingBag, User, ChevronDown, Menu, X, LogOut, Package } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useCart } from "@/context/cart-context"
import { useAuth } from "@/context/auth-context"

const categoryLinks = [
  { label: "Audio y conectividad", href: "/categorias/audio-conectividad" },
  { label: "Confort y bienestar", href: "/categorias/confort-bienestar" },
  { label: "Setup y escritorio", href: "/categorias/setup-escritorio" },
]

export function SiteHeader() {
  const { cart, total, openCart } = useCart()
  const { user, logout } = useAuth()

  const [catOpen, setCatOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const catRef = useRef<HTMLDivElement>(null)
  const userRef = useRef<HTMLDivElement>(null)

  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0)

  const userInitials = user
    ? user.name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
    : null

  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false)
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserOpen(false)
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
    <header className="fixed top-0 left-0 right-0 z-50 bg-black/85 backdrop-blur-md border-b border-white/10">
      <nav className="container mx-auto px-4 lg:px-8">
        <div className="grid grid-cols-site-header items-center h-16 lg:h-20">

          {/* ── Logo ── */}
          <Link
            href="/"
            className="shrink-0 font-heading text-26px lg:text-28px font-bold tracking-tight uppercase text-white hover:text-white/90 transition-colors"
          >
            BEYONIX
          </Link>

          {/* ── Nav desktop ── */}
          <div className="hidden lg:flex items-center justify-center gap-8">
            <Link
              href="/"
              className="text-sm font-medium text-white/80 hover:text-white transition-colors"
            >
              Inicio
            </Link>

            <Link
              href="/productos"
              className="text-sm font-medium text-white/80 hover:text-white transition-colors"
            >
              Productos
            </Link>

            {/* Dropdown Categorías */}
            <div ref={catRef} className="relative">
              <button
                type="button"
                aria-label="Abrir categorias"
                title="Abrir categorias"
                onClick={() => setCatOpen((v) => !v)}
                className="flex items-center gap-1.5 text-sm font-medium text-white/80 hover:text-white transition-colors cursor-pointer"
              >
                Categorías
                <ChevronDown
                  className={`size-3.5 transition-transform duration-200 ${catOpen ? "rotate-180" : ""}`}
                />
              </button>

              {catOpen && (
                <div className="absolute left-0 mt-3 w-52 overflow-hidden rounded-xl border border-white/10 bg-beyonix-surface-2 shadow-2xl shadow-black/60 z-50">
                  {categoryLinks.map((link, i) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={() => setCatOpen(false)}
                      className={`block px-4 py-3 text-sm text-white/75 hover:bg-white/5 hover:text-white transition-colors ${
                        i < categoryLinks.length - 1 ? "border-b border-white/6" : ""
                      }`}
                    >
                      {link.label}
                    </Link>
                  ))}
                  <Link
                    href="/categorias"
                    onClick={() => setCatOpen(false)}
                    className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-beyonix-cyan hover:bg-white/5 transition-colors border-t border-white/6"
                  >
                    Ver todas →
                  </Link>
                </div>
              )}
            </div>

            <Link
              href="/#contacto"
              className="text-sm font-medium text-white/80 hover:text-white transition-colors"
            >
              Contacto
            </Link>
          </div>

          {/* ── Acciones derecha ── */}
          <div className="flex items-center justify-end gap-2">

            {/* Usuario desktop */}
            <div ref={userRef} className="hidden lg:block relative">
              {user ? (
                <>
                  <button
                    type="button"
                    aria-label="Abrir menu de usuario"
                    title="Abrir menu de usuario"
                    onClick={() => setUserOpen((v) => !v)}
                    className="flex items-center gap-2 h-9 px-3 rounded-lg border border-white/8 bg-white/3 hover:bg-white/6 hover:border-white/15 transition-all cursor-pointer"
                  >
                    <div className="size-6 rounded-md bg-beyonix-blue border border-beyonix-blue-light/50 flex items-center justify-center text-10px font-bold text-white shrink-0">
                      {userInitials}
                    </div>
                    <span className="text-sm font-medium text-white/80 max-w-90px truncate">
                      {user.name.split(" ")[0]}
                    </span>
                    <ChevronDown
                      className={`size-3 text-white/50 transition-transform duration-200 ${userOpen ? "rotate-180" : ""}`}
                    />
                  </button>

                  {userOpen && (
                    <div className="absolute right-0 mt-2 w-48 overflow-hidden rounded-xl border border-white/10 bg-beyonix-surface-2 shadow-2xl shadow-black/60 z-50">
                      <Link
                        href="/cuenta"
                        onClick={() => setUserOpen(false)}
                        className="flex items-center gap-2.5 px-4 py-3 text-sm text-white/75 hover:bg-white/5 hover:text-white transition-colors border-b border-white/6"
                      >
                        <User className="size-3.5 shrink-0" />
                        Mi cuenta
                      </Link>
                      <Link
                        href="/cuenta?tab=ordenes"
                        onClick={() => setUserOpen(false)}
                        className="flex items-center gap-2.5 px-4 py-3 text-sm text-white/75 hover:bg-white/5 hover:text-white transition-colors border-b border-white/6"
                      >
                        <Package className="size-3.5 shrink-0" />
                        Mis órdenes
                      </Link>
                      <button
                        type="button"
                        aria-label="Cerrar sesión"
                        title="Cerrar sesión"
                        onClick={() => { logout(); setUserOpen(false) }}
                        className="flex w-full items-center gap-2.5 px-4 py-3 text-sm text-white/75 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
                      >
                        <LogOut className="size-3.5 shrink-0" />
                        Cerrar sesión
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <Link
                  href="/cuenta"
                  className="flex items-center gap-2 h-9 px-3.5 rounded-lg border border-white/8 text-sm font-medium text-white/70 hover:text-white hover:border-white/20 transition-colors"
                >
                  <User className="size-3.5" />
                  Iniciar sesión
                </Link>
              )}
            </div>

            {/* Carrito */}
            <button
              type="button"
              onClick={openCart}
              aria-label="Abrir carrito"
              title="Abrir carrito"
              className="relative flex items-center gap-2.5 h-9 pl-3 pr-3 rounded-lg border border-white/8 bg-white/3 hover:bg-white/6 hover:border-white/15 transition-all cursor-pointer"
            >
              <ShoppingBag className="size-4.5 shrink-0 text-white/80" />

              <div className="hidden sm:flex flex-col items-start leading-none gap-0.5">
                <span className="text-10px font-medium text-white/50 uppercase tracking-wide">
                  Tu carrito
                </span>
                <span className="text-sm font-bold text-white tabular-nums">
                  {total.toLocaleString("es-AR", {
                    style: "currency",
                    currency: "ARS",
                    minimumFractionDigits: 0,
                  })}
                </span>
              </div>

              {itemCount > 0 && (
                <Badge className="absolute -top-1.5 -right-1.5 size-5 p-0 flex items-center justify-center text-10px font-bold bg-beyonix-blue border border-beyonix-blue-light text-white rounded-full">
                  {itemCount}
                </Badge>
              )}
            </button>

            {/* Hamburger */}
            <button
              type="button"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Abrir menu"
              title="Abrir menu"
              className="lg:hidden flex items-center justify-center size-10 rounded-lg text-white/80 hover:text-white hover:bg-white/8 transition-colors cursor-pointer"
            >
              {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        {/* ── Mobile menu ── */}
        {mobileOpen && (
          <div className="lg:hidden border-t border-white/6 py-4 space-y-1">
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
                className="block px-2 py-3 text-sm font-medium text-white/80 hover:text-white transition-colors"
              >
                {link.label}
              </Link>
            ))}

            <div className="pt-2 border-t border-white/6 mt-2">
              {user ? (
                <>
                  <Link
                    href="/cuenta"
                    onClick={() => setMobileOpen(false)}
                    className="block px-2 py-3 text-sm font-medium text-white/80 hover:text-white transition-colors"
                  >
                    Mi cuenta ({user.name.split(" ")[0]})
                  </Link>
                  <button
                    type="button"
                    aria-label="Cerrar sesión"
                    title="Cerrar sesión"
                    onClick={() => { logout(); setMobileOpen(false) }}
                    className="block w-full text-left px-2 py-3 text-sm font-medium text-white/60 hover:text-white transition-colors cursor-pointer"
                  >
                    Cerrar sesión
                  </button>
                </>
              ) : (
                <Link
                  href="/cuenta"
                  onClick={() => setMobileOpen(false)}
                  className="block px-2 py-3 text-sm font-medium text-beyonix-cyan hover:text-white transition-colors"
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
