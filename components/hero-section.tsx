"use client"

import Image from "next/image"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

const trustItems = [
  { title: "Productos premium", sub: "Selección exclusiva" },
  { title: "Tecnología útil", sub: "Para tu día a día" },
  { title: "Envío a todo el país", sub: "Por Andreani" },
]

export function HeroSection() {
  return (
    <section className="relative min-h-92vh flex items-center overflow-hidden pt-20">

      {/* Fondo */}
      <div className="absolute inset-0 z-0">
        <Image
          src="/images/hero-bg.jpg"
          alt="BEYONIX — Tecnología para tu comodidad"
          fill
          className="object-cover"
          priority
        />
        {/* Gradiente: opaco a la izquierda, transparente a la derecha */}
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/65 to-transparent" />
        {/* Gradiente inferior sutil */}
        <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black/60 to-transparent" />
      </div>

      {/* Contenido */}
      <div className="relative z-10 container mx-auto px-6 lg:px-12">
        <div className="max-w-xl">

          {/* Label */}
          <div className="mb-6">
            <span className="inline-flex items-center gap-2 text-11px font-semibold tracking-widest text-white/70 uppercase border border-white/15 px-4 py-2 rounded-full">
              <span className="size-1.5 rounded-full bg-beyonix-cyan inline-block" />
              Tecnología Premium
            </span>
          </div>

          {/* Título */}
          <h1 className="text-3xl sm:text-4xl lg:text-5xl xl:text-6xl font-bold tracking-tight text-white mb-6 leading-1-1">
            Tecnología pensada{" "}
            <span className="text-white/85">para tu comodidad</span>
          </h1>

          {/* Subtítulo */}
          <p className="text-base lg:text-lg text-white/65 max-w-md mb-10 leading-relaxed">
            Descubrí productos premium que transforman tu espacio
            y mejoran tu día a día.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-start gap-3">
            <Link
              href="/productos"
              className="inline-flex items-center gap-2 h-12 px-6 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 transition-colors"
            >
              Explorar tienda
              <ArrowRight className="size-4" />
            </Link>

            <Link
              href="/categorias"
              className="inline-flex items-center gap-2 h-12 px-6 rounded-xl border border-white/20 text-white text-sm font-medium hover:bg-white/8 hover:border-white/35 transition-colors"
            >
              Ver categorías
            </Link>
          </div>

          {/* Trust badges */}
          <div className="mt-14 pt-8 border-t border-white/10">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 sm:gap-0">
              {trustItems.map((item, i) => (
                <div key={item.title} className="flex items-center gap-6 sm:gap-0">
                  <div className="flex flex-col">
                    <span className="text-15px font-semibold text-white">
                      {item.title}
                    </span>
                    <span className="text-13px text-white/60">
                      {item.sub}
                    </span>
                  </div>
                  {i < trustItems.length - 1 && (
                    <div className="hidden sm:block w-px h-8 bg-white/15 mx-8" />
                  )}
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>
    </section>
  )
}