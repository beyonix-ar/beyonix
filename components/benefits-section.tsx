import { CreditCard, MessageCircle, ShieldCheck, Truck } from "lucide-react"

import {
  BeyonixCard,
  BeyonixIconBox,
  BeyonixSectionHeader,
} from "@/components/beyonix-ui"

const benefits = [
  {
    icon: Truck,
    title: "Envíos por Andreani",
    description:
      "Seguimiento online y tiempos de entrega según la región de destino.",
  },
  {
    icon: ShieldCheck,
    title: "Garantía por fallas de origen",
    description:
      "Porque la confianza también se construye después de la compra.",
  },
  {
    icon: MessageCircle,
    title: "Atención personalizada",
    description:
      "Te acompañamos antes y después de la compra por nuestros canales de contacto.",
  },
  {
    icon: CreditCard,
    title: "Pagos seguros",
    description:
      "Medios disponibles al finalizar la compra, procesados mediante plataformas seguras.",
  },
]

export function BenefitsSection() {
  return (
    <section id="beneficios" className="scroll-mt-20 beyonix-section-spacing">
      <div className="container mx-auto px-4 lg:px-8">
        <BeyonixSectionHeader
          align="center"
          eyebrow="Por qué elegirnos"
          title="Comprá con confianza"
        />

        <div className="grid grid-cols-1 gap-[clamp(1rem,1.4vw,1.35rem)] sm:grid-cols-2 lg:grid-cols-4">
          {benefits.map((benefit) => {
            const Icon = benefit.icon

            return (
              <BeyonixCard
                key={benefit.title}
                variant="information"
                className="flex min-h-220px flex-col items-center p-[clamp(1.15rem,1.6vw,1.5rem)] text-center"
              >
                <BeyonixIconBox size="lg" className="mb-4 text-white">
                  <Icon className="size-5" />
                </BeyonixIconBox>

                <h3 className="mb-2 text-sm font-semibold text-white">
                  {benefit.title}
                </h3>

                <p className="text-sm leading-relaxed text-white/58">
                  {benefit.description}
                </p>
              </BeyonixCard>
            )
          })}
        </div>
      </div>
    </section>
  )
}
