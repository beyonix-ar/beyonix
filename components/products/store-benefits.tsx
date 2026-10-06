import { CreditCard, Headphones, ShieldCheck, Truck } from "lucide-react"

import { DEFAULT_PRODUCT_WARRANTY_MONTHS } from "@/lib/orders/warranty-policy"

// Sólo beneficios que el sistema cumple siempre: envío Andreani a todo el país,
// pago por Mercado Pago (las cuotas dependen de lo que confirme Mercado Pago),
// garantía legal y atención por los canales oficiales.
const STORE_BENEFITS = [
  { label: "Envíos a todo el país", icon: Truck },
  { label: "Pagos con Mercado Pago", icon: CreditCard },
  { label: `Garantía legal de ${DEFAULT_PRODUCT_WARRANTY_MONTHS} meses`, icon: ShieldCheck },
  { label: "Atención personalizada", icon: Headphones },
]

/** Beneficios de la tienda (Productos y Categoría): 2 columnas compactas en móvil. */
export function StoreBenefits() {
  return (
    <div className="mt-6 grid w-full max-w-4xl grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      {STORE_BENEFITS.map(({ label, icon: Icon }) => (
        <div
          key={label}
          className="beyonix-benefit-item flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left sm:gap-3 sm:px-3 sm:py-3"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-beyonix-blue-light/24 bg-beyonix-blue/34 text-white shadow-[0_0_8px_rgba(30,140,255,0.08)] sm:size-10">
            <Icon className="size-4" />
          </span>
          <span className="beyonix-modal-title min-w-0 text-xs font-semibold leading-tight text-white/86 sm:text-13px">
            {label}
          </span>
        </div>
      ))}
    </div>
  )
}
