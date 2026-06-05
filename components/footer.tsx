"use client"

import { useEffect, useState } from "react"

import Link from "next/link"

import {
  Instagram,
  Mail,
} from "lucide-react"
import { BeyonixLogoLink } from "@/components/beyonix-logo-link"
import type { SupabaseCategoria } from "@/lib/supabase/types"
import { getStoreCategorias } from "@/lib/supabase/queries/store"

const EMAIL = "beyonix.ar@gmail.com"
const EMAIL_SUBJECT = "Consulta desde beyonix.com.ar"
const GMAIL_COMPOSE_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(EMAIL)}&su=${encodeURIComponent(EMAIL_SUBJECT)}`

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

export function Footer() {
  const [categorias, setCategorias] =
    useState<SupabaseCategoria[]>([])

  useEffect(() => {
    let active = true

    getStoreCategorias()
      .then((data) => {
        if (active) {
          setCategorias(data.slice(0, 4))
        }
      })
      .catch((error) => {
        console.error("Error cargando categorias del footer:", error)
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
      <div className="h-px bg-gradient-to-r from-transparent via-beyonix-blue-light to-transparent opacity-70" />

      <div className="container mx-auto px-4 py-12 lg:px-8 lg:py-14">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl border border-beyonix-blue-light/12 bg-beyonix-surface p-5 shadow-2xl shadow-black/25 sm:col-span-2 lg:col-span-1">
            <BeyonixLogoLink />
            <div className="mt-3 h-px w-16 bg-beyonix-blue-light/70" />

            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/62">
              Conectados con tu comodidad.
            </p>

            <div className="mt-6 flex gap-3">
              <a
                href="https://instagram.com/beyonix.ar"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Abrir Instagram de Beyonix"
                title="Abrir Instagram de Beyonix"
                className="flex size-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/25 bg-beyonix-blue/15 text-beyonix-cyan transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue hover:text-white"
              >
                <Instagram className="size-4" />
              </a>

              <a
                href={GMAIL_COMPOSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Abrir Gmail para enviar email a Beyonix"
                title="Abrir Gmail para enviar email a Beyonix"
                className="flex size-10 cursor-pointer items-center justify-center rounded-xl border border-beyonix-blue-light/25 bg-beyonix-blue/15 text-beyonix-cyan transition-colors hover:border-beyonix-blue-light hover:bg-beyonix-blue hover:text-white"
              >
                <Mail className="size-4" />
              </a>
            </div>
          </div>

          <div className="rounded-2xl border border-beyonix-blue-light/12 bg-beyonix-surface p-5 shadow-2xl shadow-black/25">
            <h3 className="mb-5 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Tienda
            </h3>

            <ul className="space-y-3">
              {categorias.map((categoria) => (
                <li key={categoria.id}>
                  <Link
                    href={`/categorias/${categoria.slug}`}
                    aria-label={`Ver categoría ${categoria.nombre}`}
                    title={`Ver categoría ${categoria.nombre}`}
                    className="cursor-pointer text-sm text-white/68 transition-colors hover:text-beyonix-cyan"
                  >
                    {categoria.nombre}
                  </Link>
                </li>
              ))}

              <li>
                <Link
                  href="/productos"
                  aria-label="Ver todos los productos"
                  title="Ver todos los productos"
                  className="cursor-pointer text-sm text-white/68 transition-colors hover:text-beyonix-cyan"
                >
                  Ver todos los productos
                </Link>
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-beyonix-blue-light/12 bg-beyonix-surface p-5 shadow-2xl shadow-black/25">
            <h3 className="mb-5 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Información
            </h3>

            <ul className="space-y-3">
              {infoLinks.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    aria-label={link.label}
                    title={link.label}
                    className="cursor-pointer text-sm text-white/68 transition-colors hover:text-beyonix-cyan"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-beyonix-blue-light/12 bg-beyonix-surface p-5 shadow-2xl shadow-black/25">
            <h3 className="mb-5 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              Contacto
            </h3>

            <ul className="space-y-3">
              {contactLinks.map((link) => (
                <li key={link.label}>
                  {link.external ? (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={link.label}
                      title={link.label}
                      className="cursor-pointer text-sm text-white/68 transition-colors hover:text-beyonix-cyan"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      aria-label={link.label}
                      title={link.label}
                      className="cursor-pointer text-sm text-white/68 transition-colors hover:text-beyonix-cyan"
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>

            <div className="mt-5 space-y-2 border-l border-beyonix-blue-light/30 pl-4 text-sm leading-relaxed text-white/52">
              <p>Rosario, Santa Fe</p>
              <p>Envíos a todo el país</p>
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-beyonix-blue-light/12 pt-7">
          <p className="text-center text-sm text-white/40">
            © 2026 BEYONIX. Todos los derechos reservados.
          </p>
        </div>
      </div>
    </footer>
  )
}
