import { Truck, ShieldCheck, Headphones, CreditCard } from "lucide-react"

const benefits = [
  {
    icon: Truck,
    title: "Envíos rápidos por Andreani",
    description: "Seguimiento nacional · 2 a 7 días hábiles",
  },
  {
    icon: ShieldCheck,
    title: "Calidad garantizada",
    description: "Garantía de 6 meses en todos los productos",
  },
  {
    icon: Headphones,
    title: "Atención personalizada",
    description: "Soporte por WhatsApp de Lun a Sáb",
  },
  {
    icon: CreditCard,
    title: "Pagos seguros",
    description: "Mercado Pago y todas las tarjetas",
  },
]

export function BenefitsSection() {
  return (
    <section className="py-16 lg:py-24 bg-background border-y border-border">
      <div className="container mx-auto px-4 lg:px-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-12">
          {benefits.map((benefit) => (
            <div key={benefit.title} className="text-center">
              <div className="inline-flex items-center justify-center size-12 rounded-full bg-secondary mb-4">
                <benefit.icon className="size-5 text-foreground" />
              </div>
              <h3 className="font-semibold text-foreground mb-2">
                {benefit.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {benefit.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
