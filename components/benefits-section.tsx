import { Truck, ShieldCheck, MessageCircle, CreditCard } from "lucide-react"

const benefits = [
  {
    icon: Truck,
    title: "Envíos por Andreani",
    description: "A todo el país · Seguimiento en tiempo real · 2 a 7 días hábiles",
  },
  {
    icon: ShieldCheck,
    title: "Garantía incluida",
    description: "6 meses de garantía en todos los productos. Sin vueltas.",
  },
  {
    icon: MessageCircle,
    title: "Atención por WhatsApp",
    description: "Respondemos de lunes a sábado. Rápido y sin robots.",
  },
  {
    icon: CreditCard,
    title: "Pagos seguros",
    description: "Mercado Pago, transferencia, débito y crédito.",
  },
]

export function BenefitsSection() {
  return (
    <section id="beneficios" className="py-16 lg:py-20 bg-[#050505] border-y border-white/[6%] scroll-mt-20">
      <div className="container mx-auto px-4 lg:px-8">

        {/* Header de sección */}
        <div className="text-center mb-12">
          <p className="text-[11px] font-semibold uppercase tracking-[0.25em] text-[#4A90B8] mb-2">
            Por qué elegirnos
          </p>
          <h2 className="text-2xl lg:text-3xl font-bold text-white tracking-tight">
            Comprá con confianza
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
          {benefits.map((benefit) => (
            <div
              key={benefit.title}
              className="flex flex-col items-center text-center p-6 rounded-2xl border border-white/[6%] bg-white/[2%] hover:border-white/10 hover:bg-white/[3%] transition-all duration-200"
            >
              <div className="inline-flex items-center justify-center size-11 rounded-xl bg-[#112A43]/60 border border-[#1E4D7B]/40 mb-4">
                <benefit.icon className="size-5 text-[#4A90B8]" />
              </div>
              <h3 className="font-semibold text-white mb-2 text-[15px]">
                {benefit.title}
              </h3>
              <p className="text-sm text-white/45 leading-relaxed">
                {benefit.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}