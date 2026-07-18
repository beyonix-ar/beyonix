"use client"

import { useEffect, useState, type ReactNode } from "react"

import Link from "next/link"

import { Instagram, Mail } from "lucide-react"
import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import { BeyonixCard, BeyonixIconBox } from "@/components/beyonix-ui"
import {
  BEYONIX_EMAIL,
  BEYONIX_WITHDRAWAL_URL,
} from "@/lib/legal-contact"
import type { SupabaseCategoria } from "@/lib/supabase/types"
import { getStoreCategorias } from "@/lib/supabase/queries/store"
import { cn } from "@/lib/utils"

const EMAIL_SUBJECT = "Consulta desde beyonix.com.ar"
const GMAIL_COMPOSE_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(BEYONIX_EMAIL)}&su=${encodeURIComponent(EMAIL_SUBJECT)}`

const infoLinks = [
  {
    label: "Sobre nosotros",
    href: "/sobre-nosotros",
  },
  {
    label: "Términos y condiciones",
    href: "/terminos",
  },
  {
    label: "Política de privacidad",
    href: "/privacidad",
  },
  {
    label: "Devoluciones",
    href: "/devoluciones",
  },
  {
    label: "Contacto",
    href: "/contacto",
  },
]

const contactLinks = [
  {
    label: "Instagram",
    href: "https://instagram.com/beyonix.ar",
    external: true,
  },
  {
    label: "Email",
    href: GMAIL_COMPOSE_URL,
    external: true,
  },
  {
    label: "Contacto",
    href: "/contacto",
    external: false,
  },
]

const footerLinkClass =
  "inline-flex rounded-md text-sm text-white/64 outline-none transition-colors hover:text-white focus-visible:text-white focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"

function FooterColumn({
  title,
  children,
  className,
}: {
  title: string
  children: ReactNode
  className?: string
}) {
  return (
    <BeyonixCard variant="information" className={cn("p-5", className)}>
      <h3 className="mb-5 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
        {title}
      </h3>
      {children}
    </BeyonixCard>
  )
}

export function Footer() {
  const [categorias, setCategorias] = useState<SupabaseCategoria[]>([])
  const currentYear = new Date().getFullYear()

  useEffect(() => {
    let active = true

    getStoreCategorias()
      .then((data) => {
        if (active) {
          setCategorias(data.slice(0, 4))
        }
      })
      .catch((error) => {
        console.error("Error cargando categorías del footer:", error)
      })

    return () => {
      active = false
    }
  }, [])

  return (
    <footer
      id="contacto"
      className="border-t border-beyonix-blue-light/16 bg-beyonix-page"
    >
      <div className="h-px bg-linear-to-r from-transparent via-beyonix-blue-light/70 to-transparent" />

      <div className="container mx-auto px-4 py-12 lg:px-8 lg:py-14">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <BeyonixCard
            variant="information"
            className="p-5 sm:col-span-2 lg:col-span-1"
          >
            <BeyonixLogoLink />
            <div className="mt-3 h-px w-16 bg-beyonix-blue-light/60" />

            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/62">
              Conectados con tu comodidad.
            </p>

            <div className="mt-6 flex gap-3">
              <a
                href="https://instagram.com/beyonix.ar"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Abrir Instagram de BEYONIX"
                className="outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
              >
                <BeyonixIconBox className="text-white hover:border-beyonix-blue-light/60">
                  <Instagram className="size-4" />
                </BeyonixIconBox>
              </a>

              <a
                href={GMAIL_COMPOSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Enviar email a BEYONIX"
                className="outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
              >
                <BeyonixIconBox className="text-white hover:border-beyonix-blue-light/60">
                  <Mail className="size-4" />
                </BeyonixIconBox>
              </a>
            </div>
          </BeyonixCard>

          <FooterColumn title="Tienda">
            <ul className="space-y-3">
              {categorias.map((categoria) => (
                <li key={categoria.id}>
                  <Link
                    href={`/categorias/${categoria.slug}`}
                    aria-label={`Ver categoría ${categoria.nombre}`}
                    className={footerLinkClass}
                  >
                    {categoria.nombre}
                  </Link>
                </li>
              ))}

              <li>
                <Link
                  href="/productos"
                  aria-label="Ver todos los productos"
                  className={footerLinkClass}
                >
                  Ver todos los productos
                </Link>
              </li>
            </ul>
          </FooterColumn>

          <FooterColumn title="Información">
            <ul className="space-y-3">
              {infoLinks.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    aria-label={link.label}
                    className={footerLinkClass}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <a
                  href={BEYONIX_WITHDRAWAL_URL}
                  aria-label="Abrir el Botón de arrepentimiento"
                  className="inline-flex rounded-md font-semibold text-beyonix-cyan outline-none transition-colors hover:text-white focus-visible:text-white focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
                >
                  Botón de arrepentimiento
                </a>
              </li>
            </ul>
          </FooterColumn>

          <FooterColumn title="Contacto">
            <ul className="space-y-3">
              {contactLinks.map((link) => (
                <li key={link.label}>
                  {link.external ? (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={link.label}
                      className={footerLinkClass}
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      aria-label={link.label}
                      className={footerLinkClass}
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-5 space-y-2 border-l border-beyonix-blue-light/24 pl-4 text-sm leading-relaxed text-white/52">
              <p>Rosario, Santa Fe</p>
              <p>Envíos a todo el país</p>
            </div>
          </FooterColumn>
        </div>

        <div className="mt-10 border-t border-beyonix-blue-light/12 pt-7">
          <p className="text-center text-sm text-white/40">
            © {currentYear} BEYONIX. Todos los derechos reservados.
          </p>
        </div>
      </div>
    </footer>
  )
}
