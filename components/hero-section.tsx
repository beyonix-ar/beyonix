"use client"

import Link from "next/link"
import { ArrowRight, CheckCircle2, PackageCheck, Sparkles } from "lucide-react"

const trustItems = [
  {
    title: "Selección cuidada",
    sub: "Productos elegidos con criterio",
    icon: CheckCircle2,
  },
  {
    title: "Tecnología útil",
    sub: "Para tu día a día",
    icon: Sparkles,
  },
  {
    title: "Envío a todo el país",
    sub: "Por Andreani",
    icon: PackageCheck,
  },
]

export function HeroSection() {
  return (
    <section className="relative min-h-92vh overflow-hidden bg-black pt-20">
      <div className="container mx-auto flex min-h-92vh items-center px-6 py-16 lg:px-12">
        <div className="w-full max-w-5xl">
          <div className="max-w-2xl">
            <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/4 px-4 py-2 text-11px font-semibold uppercase tracking-widest text-white/72">
              <span className="inline-block size-1.5 rounded-full bg-beyonix-cyan" />
              Tecnología confiable
            </span>

            <h1 className="mb-6 max-w-3xl text-4xl font-bold leading-1-1 tracking-tight text-white sm:text-5xl lg:text-6xl">
              Tecnología pensada para tu comodidad
            </h1>

            <p className="mb-10 max-w-xl text-base leading-1-8 text-white/68 lg:text-lg">
              Descubrí productos seleccionados para mejorar tu espacio, tu setup
              y tu rutina diaria.
            </p>

            <div className="flex flex-col items-start gap-3 sm:flex-row">
              <Link
                href="/productos"
                className="inline-flex h-12 items-center gap-2 rounded-lg bg-white px-6 text-sm font-semibold text-black transition-colors hover:bg-white/90"
              >
                Explorar tienda
                <ArrowRight className="size-4" />
              </Link>

              <Link
                href="/categorias"
                className="inline-flex h-12 items-center rounded-lg border border-white/18 px-6 text-sm font-medium text-white transition-colors hover:border-white/32 hover:bg-white/6"
              >
                Ver categorías
              </Link>
            </div>
          </div>

          <div className="mt-16 max-w-4xl border-t border-white/10 pt-7">
            <div className="grid gap-4 sm:grid-cols-3">
              {trustItems.map((item) => {
                const Icon = item.icon

                return (
                  <div
                    key={item.title}
                    className="flex min-h-20 items-start gap-3 rounded-lg border border-white/10 bg-white/3 p-4"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-beyonix-cyan/25 bg-beyonix-blue/35 text-beyonix-sky">
                      <Icon className="size-4" />
                    </span>

                    <div className="min-w-0">
                      <span className="block text-sm font-semibold leading-5 text-white">
                        {item.title}
                      </span>
                      <span className="mt-1 block text-13px leading-5 text-white/58">
                        {item.sub}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="mt-14 grid max-w-4xl grid-cols-2 gap-px overflow-hidden rounded-lg border border-white/10 bg-white/10 sm:grid-cols-4">
            {["Audio", "Setup", "Bienestar", "Smart home"].map((label) => (
              <Link
                key={label}
                href="/categorias"
                className="bg-black px-4 py-3 text-center text-12-5px font-medium uppercase tracking-wide text-white/52 transition-colors hover:text-white"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
