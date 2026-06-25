"use client"

import Link from "next/link"
import { ArrowRight, CheckCircle2, PackageCheck, Sparkles } from "lucide-react"

import { beyonixHoverBorder, cn } from "@/lib/utils"

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
    sub: "Entrega segura y con seguimiento",
    icon: PackageCheck,
  },
]

export function HeroSection() {
  return (
    <section className="relative min-h-80vh overflow-hidden pt-18 lg:pt-20">
      <div className="container relative mx-auto flex min-h-80vh items-center px-4 py-12 sm:px-6 lg:px-10 lg:py-14">
        <div className="grid w-full gap-9 lg:gap-10">
          <div className="max-w-3xl">
            <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/4 px-3.5 py-2 text-11px font-semibold uppercase tracking-widest text-white/72 lg:mb-6">
              <span className="inline-block size-1.5 rounded-full bg-beyonix-cyan" />
              Conexión y comodidad
            </span>

            <h1 className="mb-5 max-w-3xl text-4xl font-bold leading-1-1 tracking-tight text-white sm:text-5xl lg:text-6xl">
              Conectados con tu comodidad
            </h1>

            <p className="mb-8 max-w-xl text-base leading-1-8 text-white/68 lg:text-lg">
              Tecnología premium, práctica y confiable para acompañar tu día a día con estilo.
            </p>

            <div className="flex flex-col items-start gap-3 sm:flex-row">
              <Link
                href="/productos"
                className={cn(
                  "inline-flex h-11 cursor-pointer items-center gap-2 rounded-lg bg-white px-5 text-sm font-semibold text-black hover:bg-white/90 sm:h-12 sm:px-6",
                  beyonixHoverBorder
                )}
              >
                Explorar tienda
                <ArrowRight className="size-4" />
              </Link>

              <Link
                href="/categorias"
                className={cn(
                  "inline-flex h-11 cursor-pointer items-center rounded-lg px-5 text-sm font-medium text-white hover:bg-white/6 sm:h-12 sm:px-6",
                  beyonixHoverBorder
                )}
              >
                Ver categorías
              </Link>
            </div>
          </div>

          <div className="max-w-4xl border-t border-white/10 pt-6">
            <div className="grid gap-3 sm:grid-cols-3">
              {trustItems.map((item) => {
                const Icon = item.icon

                return (
                  <div
                    key={item.title}
                    className="flex min-h-22 items-center gap-3 rounded-lg border border-white/10 bg-white/3 p-3.5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-beyonix-cyan/25 bg-beyonix-blue/35 text-beyonix-sky">
                      <Icon className="size-4" />
                    </span>

                    <div className="min-w-0">
                      <span className="block text-sm font-bold leading-5 text-white sm:text-base">
                        {item.title}
                      </span>
                      <span className="mt-1 block text-11px leading-5 text-white/52">
                        {item.sub}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
