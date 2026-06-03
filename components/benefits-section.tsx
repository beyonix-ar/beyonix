import { CreditCard, MessageCircle, ShieldCheck, Truck } from "lucide-react"

const benefits = [
  {
    icon: Truck,
    title: "Envíos por Andreani",
    description:
      "A todo el país - Seguimiento en tiempo real - Entrega estimada: 2 a 7 días hábiles",
  },
  {
    icon: ShieldCheck,
    title: "Garantía por fallas de origen",
    description:
      "Cobertura de 30 días corridos, según nuestros términos y condiciones.",
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
    <section
      id="beneficios"
      className="scroll-mt-20 py-16 lg:py-20"
    >
      <div className="container mx-auto px-4 lg:px-8">
        <div className="mb-12 text-center">
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-sky-300">
            Por qué elegirnos
          </p>

          <h2 className="text-2xl font-bold tracking-tight text-white lg:text-3xl">
            Comprá con confianza
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
          {benefits.map((benefit) => (
            <div
              key={benefit.title}
              className="flex flex-col items-center rounded-2xl border border-white/10 bg-white/5 p-6 text-center transition-all duration-200 hover:border-white/20 hover:bg-white/10"
            >
              <div className="mb-4 inline-flex size-11 items-center justify-center rounded-xl border border-sky-700/40 bg-sky-950/60">
                <benefit.icon className="size-5 text-sky-300" />
              </div>

              <h3 className="mb-2 text-sm font-semibold text-white">
                {benefit.title}
              </h3>

              <p className="text-sm leading-relaxed text-white/55">
                {benefit.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
