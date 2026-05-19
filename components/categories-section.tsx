"use client"

import Image from "next/image"
import { ArrowUpRight } from "lucide-react"
import { useRouter } from "next/navigation"

const categories = [
  {
    id: 1,
    name: "Audio y conectividad",
    slug: "audio-conectividad",
    image: "/images/categories/audio.jpg",
    description: "Auriculares y cables",
  },
  {
    id: 2,
    name: "Confort y bienestar",
    slug: "confort-bienestar",
    image: "/images/categories/mate.jpg",
    description: "Momentos cómodos y prácticos",
  },
  {
    id: 3,
    name: "Setup y escritorio",
    slug: "setup-escritorio",
    image: "/images/categories/smart-home.jpg",
    description: "Accesorios para tu espacio",
  },
]

export function CategoriesSection() {
  const router = useRouter()

  return (
    <section id="categorias" className="py-16 lg:py-24 bg-background scroll-mt-24">
      <div className="container mx-auto px-4 lg:px-8">
        <div className="text-center mb-16 lg:mb-24">
          <p className="text-sm font-medium tracking-widest text-muted-foreground uppercase mb-3">
            Categorías
          </p>

          <h2 className="text-3xl lg:text-5xl font-bold tracking-tight text-foreground text-balance">
            Explorá nuestras categorías
          </h2>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Card grande izquierda */}
          <button
            type="button"
            aria-label="Ver categoría Audio y conectividad"
            onClick={() => router.push("/categorias/audio-conectividad")}
            className="group relative overflow-hidden rounded-2xl bg-card border border-border text-left lg:col-span-2 aspect-[16/9.2] transition-all duration-500 hover:-translate-y-1"
          >
            <div className="absolute inset-0">
              <Image
                src="/images/categories/audio.jpg"
                alt="Audio y conectividad"
                fill
                className="object-cover transition-transform duration-500 group-hover:scale-105"
              />
            </div>

            <div className="absolute inset-0 bg-linear-to-t from-background/80 via-background/20 to-transparent" />

            <div className="absolute inset-0 px-6 pb-6 flex flex-col justify-end">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h3 className="font-semibold text-foreground mb-1 text-2xl lg:text-3xl">
                    Audio y conectividad
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    Auriculares y cables
                  </p>
                </div>

                <div className="size-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <ArrowUpRight className="size-5" />
                </div>
              </div>
            </div>
          </button>

          {/* Columna derecha */}
          <div className="flex flex-col gap-4 lg:gap-6">
            {categories.slice(1).map((category) => (
              <button
                key={category.id}
                type="button"
                aria-label={`Ver categoría ${category.name}`}
                onClick={() => router.push(`/categorias/${category.slug}`)}
                className="group relative overflow-hidden rounded-2xl bg-card border border-border text-left flex-1 aspect-video transition-all duration-500 hover:-translate-y-1"
              >
                <div className="absolute inset-0">
                  <Image
                    src={category.image}
                    alt={category.name}
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-100"
                  />
                </div>

                <div className="absolute inset-0 bg-linear-to-t from-black/85 via-black/20 to-transparent" />

                <div className="absolute inset-0 px-6 pb-6 flex flex-col justify-end">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <h3 className="font-semibold text-foreground mb-1 text-base lg:text-lg">
                        {category.name}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {category.description}
                      </p>
                    </div>

                    <div className="size-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <ArrowUpRight className="size-5" />
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}