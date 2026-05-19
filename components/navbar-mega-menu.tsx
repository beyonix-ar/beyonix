"use client"

import Link from "next/link"

interface NavbarMegaMenuItem {
  label: string
  href: string
}

interface NavbarMegaMenuProps {
  label: string
  href: string
  items: NavbarMegaMenuItem[]
}

const categoryItems = [
  {
    label: "Auriculares y conectividad",
    href: "/categorias/audio-conectividad",
  },
  {
    label: "Confort y bienestar",
    href: "/categorias/confort-y-bienestar",
  },
  {
    label: "Setup y escritorio",
    href: "/categorias/setup-y-escritorio",
  },
]

export function NavbarMegaMenu({
  label,
  href,
  items,
}: NavbarMegaMenuProps) {
  return (
    <div className="relative group">
      <button
        type="button"
        className="text-[14px] font-medium text-white/75 hover:text-white transition-colors cursor-pointer"
        aria-label={`Abrir menú de ${label}`}
      >
        {label}
      </button>

      <div className="absolute left-0 top-full pt-4 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300 z-100">
        <div className="relative w-420px rounded-md bg-black shadow-none py-3">
          {/* ✅ VER TODOS LOS PRODUCTOS */}
          <Link
            href={href}
            className="block px-5 py-3 text-sm font-semibold text-white hover:bg-white/25 transition-colors whitespace-nowrap"
          >
            Ver productos
          </Link>

          {/* ✅ VER CATEGORÍAS */}
          <div className="relative group/categories">
          <Link
            href="/categorias"
            className="flex w-full items-center justify-between gap-4 px-5 py-3 text-sm font-semibold text-white hover:bg-white/25 transition-colors whitespace-nowrap"
          >
            <span>Ver categorías</span>
            <span className="text-white/50">→</span>
          </Link>

            <div className="absolute left-full top-0.5 opacity-0 invisible group-hover/categories:opacity-100 group-hover/categories:visible transition-all duration-300">
              <div className="w-320px rounded-md bg-black shadow-none">
                {categoryItems.map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    className="block px-5 py-3 text-sm font-medium text-white/80 hover:text-white hover:bg-white/25 transition-colors whitespace-nowrap"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {items.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="block px-5 py-3 text-sm font-medium text-white/80 hover:text-white hover:bg-white/25 transition-colors whitespace-nowrap"
            >
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}