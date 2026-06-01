"use client"

import Link from "next/link"
import { ArrowRight, CheckCircle2, PackageCheck, Sparkles } from "lucide-react"

const trustItems = [
  {
    title: "Seleccion cuidada",
    sub: "Productos elegidos con criterio",
    icon: CheckCircle2,
  },
  {
    title: "Tecnologia util",
    sub: "Para tu dia a dia",
    icon: Sparkles,
  },
  {
    title: "Envio a todo el pais",
    sub: "Entrega segura y con seguimiento",
    icon: PackageCheck,
  },
]

const featureTiles = ["Variantes", "Stock real", "Cuotas", "Envios"]

export function HeroSection() {
  return (
    <section className="relative min-h-92vh overflow-hidden bg-black pt-20">
      <div className="pointer-events-none absolute inset-0 beyonix-category-radial-bg" />

      <div className="container relative mx-auto flex min-h-92vh items-center px-6 py-16 lg:px-12">
        <div className="grid w-full gap-12 lg:grid-cols-hero-premium lg:items-center">
          <div className="max-w-2xl">
            <span className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/4 px-4 py-2 text-11px font-semibold uppercase tracking-widest text-white/72">
              <span className="inline-block size-1.5 rounded-full bg-beyonix-cyan" />
              Tecnologia confiable
            </span>

            <h1 className="mb-6 max-w-3xl text-4xl font-bold leading-1-1 tracking-tight text-white sm:text-5xl lg:text-6xl">
              Tecnologia premium para elevar tu rutina
            </h1>

            <p className="mb-10 max-w-xl text-base leading-1-8 text-white/68 lg:text-lg">
              Descubri productos seleccionados con criterio, variantes reales y una experiencia de compra clara de principio a fin.
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
                Ver categorias
              </Link>
            </div>
          </div>

          <div className="relative hidden min-h-420px lg:block">
            <div className="absolute inset-0 rounded-3xl border border-white/10 bg-beyonix-surface shadow-2xl shadow-black/45" />
            <div className="absolute inset-4 rounded-2xl border border-beyonix-blue-light/18 bg-black/60 p-5">
              <div className="flex h-full flex-col justify-between">
                <div>
                  <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                    Tienda Beyonix
                  </p>
                  <p className="mt-3 max-w-sm text-3xl font-bold leading-tight text-white">
                    Categorias dinamicas, productos activos y compra simple.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {featureTiles.map((item) => (
                    <div
                      key={item}
                      className="rounded-2xl border border-white/8 bg-white/4 p-4"
                    >
                      <p className="text-sm font-semibold text-white">{item}</p>
                      <p className="mt-2 h-1 w-12 rounded-full bg-beyonix-cyan" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="max-w-4xl border-t border-white/10 pt-7 lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-3">
              {trustItems.map((item) => {
                const Icon = item.icon

                return (
                  <div
                    key={item.title}
                    className="flex min-h-22 items-center gap-3 rounded-lg border border-white/10 bg-white/3 p-4"
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
        </div>
      </div>
    </section>
  )
}
