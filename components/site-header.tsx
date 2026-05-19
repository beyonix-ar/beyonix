"use client"

import Link from "next/link"
import { ShoppingBag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useCart } from "@/context/cart-context"
import { NavbarMegaMenu } from "@/components/navbar-mega-menu"

const navLinks = [
  { label: "Inicio", href: "/#inicio" },
  { label: "Categorías", href: "/#categorias" },
  { label: "Beneficios", href: "/#beneficios" },
  { label: "Reseñas", href: "/#reseñas" },
  { label: "Contacto", href: "/#contacto" },
]

const productDropdownLinks = [
  { label: "Más vendidos", href: "/#productos" },
  { label: "Más buscados", href: "/#mas-buscados" },
]

export function SiteHeader() {
  const { cart, total, openCart } = useCart()

  const itemCount = cart.reduce(
    (sum, item) => sum + item.quantity,
    0
  )

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-b border-white/10">
      <nav className="container mx-auto px-4 lg:px-8">
        <div className="relative flex items-center justify-between h-16 lg:h-20">
          
          <Link href="/#inicio" className="flex items-center">
            <span className="text-[38px] font-extrabold tracking-[-0.02em] uppercase text-white font-[Montserrat]">
              BEYONIX
            </span>
          </Link>

          <div className="hidden lg:flex items-center gap-8 absolute left-1/2 -translate-x-1/2">
            <Link href="/#inicio" className="text-sm font-medium text-white/75 hover:text-white">
              Inicio
            </Link>

            <NavbarMegaMenu
              label="Productos"
              href="/productos"
              items={productDropdownLinks}
            />

            {navLinks.slice(1).map((link) => (
              <Link
                key={link.label}
                href={link.href}
                className="text-sm font-medium text-white/75 hover:text-white"
              >
                {link.label}
              </Link>
            ))}
          </div>

          <Button
            type="button"
            variant="ghost"
            onClick={openCart} // ✅ ABRE CARRITO
            className="relative flex items-center gap-2 px-3 text-white hover:bg-white/10 cursor-pointer"
            aria-label="Abrir carrito"
          >
            <ShoppingBag className="size-5 shrink-0" />

            <span className="hidden md:inline text-sm font-medium">
              Tu carrito:
              <span className="mx-1 text-white/30"> </span>
              <span className="font-semibold text-[#b0d7ff]">
                {total.toLocaleString("es-AR", {
                  style: "currency",
                  currency: "ARS",
                  minimumFractionDigits: 2,
                })}
              </span>
            </span>

            {itemCount > 0 && (
              <Badge className="absolute -top-1 -right-1 size-5 p-0 flex items-center justify-center text-xs bg-[#112A43] text-white">
                {itemCount}
              </Badge>
            )}
          </Button>
        </div>
      </nav>
    </header>
  )
}