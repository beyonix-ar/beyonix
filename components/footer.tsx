"use client"

import { useState } from "react"

import Link from "next/link"

import {
  Instagram,
  Mail,
  MapPin,
  Phone,
} from "lucide-react"

const tiendaLinks = [
  {
    label: "Audio y conectividad",
    href: "/categorias/audio-conectividad",
  },
  {
    label: "Confort y bienestar",
    href: "/categorias/confort-bienestar",
  },
  {
    label: "Setup y escritorio",
    href: "/categorias/setup-escritorio",
  },
  {
    label: "Ver todos los productos",
    href: "/productos",
  },
]

const infoLinks = [
  {
    label: "Sobre nosotros",
    href: "/#inicio",
  },
  {
    label: "Contacto",
    href: "/#contacto",
  },
  {
    label: "Envíos y entregas",
    href: "/#beneficios",
  },
  {
    label: "Preguntas frecuentes",
    href: "/#beneficios",
  },
]

export function Footer() {
  const [email, setEmail] =
    useState("")

  const [sent, setSent] =
    useState(false)

  const handleSubmit = (
    e: React.FormEvent
  ) => {
    e.preventDefault()

    if (!email.trim()) return

    setSent(true)

    setEmail("")

    setTimeout(() => {
      setSent(false)
    }, 4000)
  }

  return (
    <footer
      id="contacto"
      className="border-t border-white/6 bg-beyonix-page"
    >
      <div className="container mx-auto px-4 py-14 lg:px-8 lg:py-16">
        <div className="grid grid-cols-1 gap-12 sm:grid-cols-2 lg:grid-cols-4">
          
          {/* Marca */}
          <div className="sm:col-span-2 lg:col-span-1">
            <Link
              href="/"
              className="mb-4 inline-block"
            >
              <span className="text-2xl font-bold tracking-tight text-white">
                BEYONIX
              </span>
            </Link>

            <p className="mb-6 max-w-xs text-sm leading-relaxed text-white/55">
              Tecnología para tu comodidad.
              Productos premium para
              mejorar tu día a día.
            </p>

            <div className="flex gap-3">
              <a
                href="https://instagram.com/beyonix.ar"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Instagram de BEYONIX"
                className="flex size-10 items-center justify-center rounded-xl border border-white/10 text-white/60 transition-colors hover:border-white/20 hover:text-white"
              >
                <Instagram className="size-4" />
              </a>

              <a
                href="mailto:beyonix.ar@gmail.com"
                aria-label="Enviar email"
                className="flex size-10 items-center justify-center rounded-xl border border-white/10 text-white/60 transition-colors hover:border-white/20 hover:text-white"
              >
                <Mail className="size-4" />
              </a>
            </div>
          </div>

          {/* Tienda */}
          <div>
            <h3 className="mb-5 text-11px font-semibold uppercase tracking-widest text-white/45">
              Tienda
            </h3>

            <ul className="space-y-3">
              {tiendaLinks.map(
                (link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-white/65 transition-colors hover:text-white"
                    >
                      {link.label}
                    </Link>
                  </li>
                )
              )}
            </ul>
          </div>

          {/* Información */}
          <div>
            <h3 className="mb-5 text-11px font-semibold uppercase tracking-widest text-white/45">
              Información
            </h3>

            <ul className="space-y-3">
              {infoLinks.map(
                (link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-white/65 transition-colors hover:text-white"
                    >
                      {link.label}
                    </Link>
                  </li>
                )
              )}
            </ul>
          </div>

          {/* Newsletter */}
          <div>
            <h3 className="mb-5 text-11px font-semibold uppercase tracking-widest text-white/45">
              Novedades
            </h3>

            <p className="mb-4 text-sm leading-relaxed text-white/55">
              Suscribite para recibir
              ofertas exclusivas y
              novedades.
            </p>

            <form
              onSubmit={
                handleSubmit
              }
              className="flex gap-2"
            >
              <input
                type="email"
                aria-label="Email"
                title="Email"
                placeholder="tu@email.com"
                value={email}
                onChange={(e) =>
                  setEmail(
                    e.target.value
                  )
                }
                required
                className="h-10 flex-1 rounded-xl border border-white/10 bg-white/3 px-4 text-sm text-white outline-none transition-colors placeholder:text-white/25 focus:border-beyonix-blue-light"
              />

              <button
                type="submit"
                aria-label="Suscribirse"
                title="Suscribirse"
                className="h-10 rounded-xl border border-beyonix-blue-light/50 bg-beyonix-blue px-4 text-sm font-medium text-white transition-colors hover:bg-beyonix-blue-light"
              >
                {sent ? "✓" : "OK"}
              </button>
            </form>

            <div className="mt-6 space-y-3">
              <div className="flex items-center gap-2.5 text-sm text-white/50">
                <Phone className="size-3.5 shrink-0" />

                <span>
                  +54 341 2626 527
                </span>
              </div>

              <div className="flex items-center gap-2.5 text-sm text-white/50">
                <MapPin className="size-3.5 shrink-0" />

                <span>
                  Rosario, Santa Fe
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom */}
        <div className="mt-14 flex flex-col items-center justify-between gap-5 border-t border-white/6 pt-8 sm:flex-row">
          <p className="text-center text-sm text-white/40 sm:text-left">
            © {new Date().getFullYear()}{" "}
            BEYONIX. Todos los derechos
            reservados.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-5">
            <Link
              href="/terminos"
              className="text-sm text-white/40 transition-colors hover:text-white/80"
            >
              Términos y condiciones
            </Link>

            <Link
              href="/privacidad"
              className="text-sm text-white/40 transition-colors hover:text-white/80"
            >
              Política de privacidad
            </Link>

            <Link
              href="/devoluciones"
              className="text-sm text-white/40 transition-colors hover:text-white/80"
            >
              Devoluciones
            </Link>
          </div>
        </div>
      </div>
    </footer>
  )
}