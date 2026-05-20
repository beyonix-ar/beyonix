"use client"

import { useState } from "react"
import Link from "next/link"
import { Instagram, Mail, MapPin, Phone } from "lucide-react"

const tiendaLinks = [
  { label: "Audio y conectividad", href: "/categorias/audio-conectividad" },
  { label: "Confort y bienestar", href: "/categorias/confort-bienestar" },
  { label: "Setup y escritorio", href: "/categorias/setup-escritorio" },
  { label: "Ver todos los productos", href: "/productos" },
]

const infoLinks = [
  { label: "Sobre nosotros", href: "/#inicio" },
  { label: "Contacto", href: "/#contacto" },
  { label: "Envíos y entregas", href: "/#beneficios" },
  { label: "Preguntas frecuentes", href: "/#beneficios" },
]

export function Footer() {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setSent(true)
    setEmail("")
    setTimeout(() => setSent(false), 4000)
  }

  return (
    <footer id="contacto" className="bg-[#050505] border-t border-white/[6%] scroll-mt-20">
      <div className="container mx-auto px-4 lg:px-8 py-14 lg:py-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-12">

          {/* Brand */}
          <div className="sm:col-span-2 lg:col-span-1">
            <Link href="/" className="inline-block mb-4">
              <span className="text-xl font-bold tracking-tight text-white">BEYONIX</span>
            </Link>
            <p className="text-sm text-white/40 mb-6 max-w-xs leading-relaxed">
              Tecnología para tu comodidad. Productos premium para mejorar tu día a día.
            </p>

            <div className="flex gap-2.5">
              <a
                href="https://instagram.com/beyonix.ar"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Instagram de BEYONIX"
                className="size-9 rounded-lg border border-white/10 flex items-center justify-center text-white/50 hover:text-white hover:border-white/25 transition-colors"
              >
                <Instagram className="size-4" />
              </a>
              <a
                href="mailto:hola@beyonix.com.ar"
                aria-label="Enviar email a BEYONIX"
                className="size-9 rounded-lg border border-white/10 flex items-center justify-center text-white/50 hover:text-white hover:border-white/25 transition-colors"
              >
                <Mail className="size-4" />
              </a>
            </div>
          </div>

          {/* Tienda */}
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40 mb-5">
              Tienda
            </h3>
            <ul className="space-y-3">
              {tiendaLinks.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-white/55 hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Info */}
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40 mb-5">
              Información
            </h3>
            <ul className="space-y-3">
              {infoLinks.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-white/55 hover:text-white transition-colors"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Newsletter + contacto */}
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/40 mb-5">
              Novedades
            </h3>
            <p className="text-sm text-white/40 mb-4 leading-relaxed">
              Suscribite para recibir ofertas exclusivas y novedades.
            </p>

            <form onSubmit={handleSubmit} className="flex gap-2">
              <input
                type="email"
                placeholder="tu@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="flex-1 h-9 rounded-lg border border-white/10 bg-white/[3%] px-3 text-sm text-white placeholder:text-white/30 outline-none focus:border-[#1E4D7B] transition-colors"
              />
              <button
                type="submit"
                className="h-9 px-4 rounded-lg bg-[#112A43] border border-[#1E4D7B]/50 text-sm font-medium text-white hover:bg-[#1E4D7B] transition-colors cursor-pointer"
              >
                {sent ? "✓" : "OK"}
              </button>
            </form>

            <div className="mt-6 space-y-2.5">
              <div className="flex items-center gap-2.5 text-sm text-white/40">
                <Phone className="size-3.5 shrink-0" />
                <span>+54 341 2626 527</span>
              </div>
              <div className="flex items-center gap-2.5 text-sm text-white/40">
                <MapPin className="size-3.5 shrink-0" />
                <span>Rosario, Santa Fe</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 pt-8 border-t border-white/[6%] flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-white/30">
            © {new Date().getFullYear()} BEYONIX. Todos los derechos reservados.
          </p>
          <div className="flex gap-5">
            <span className="text-sm text-white/30 cursor-default">
              Términos y condiciones
            </span>
            <span className="text-sm text-white/30 cursor-default">
              Política de privacidad
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}