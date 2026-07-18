import {
  Clock,
  CreditCard,
  Instagram,
  Mail,
  MapPin,
  Truck,
} from "lucide-react"

import {
  BEYONIX_EMAIL,
  BEYONIX_SUPPORT_HOURS,
} from "@/lib/legal-contact"

const EMAIL_SUBJECT = "Consulta desde beyonix.com.ar"
const GMAIL_COMPOSE_URL = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(BEYONIX_EMAIL)}&su=${encodeURIComponent(EMAIL_SUBJECT)}`

const infoCards = [
  {
    label: "GESTIÓN DE PEDIDOS",
    value: "Validación de pagos y consultas",
    subValue: BEYONIX_SUPPORT_HOURS,
    icon: Clock,
  },
  {
    label: "UBICACIÓN",
    value: "Rosario, Santa Fe",
    icon: MapPin,
  },
  {
    label: "ENVÍOS",
    value: "A todo el país",
    icon: Truck,
  },
  {
    label: "FORMAS DE PAGO",
    value: "Transferencia bancaria (10% OFF) y Mercado Pago",
    icon: CreditCard,
  },
]

export default function ContactoPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="bg-beyonix-page">
        <div className="mx-auto max-w-5xl px-6 pt-20 pb-16 lg:px-8 lg:pt-24 lg:pb-20">
          <div className="max-w-3xl">
            <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
              Contacto
            </h1>

            <p className="mt-4 text-xl font-semibold text-beyonix-cyan">
              Estamos para ayudarte.
            </p>

            <div className="mt-6 h-px w-20 bg-beyonix-blue-light/70" />

            <p className="mt-6 text-base leading-8 text-white/74">
              Consultas sobre productos, compras, envíos, cambios o
              devoluciones a través de nuestros canales oficiales.
            </p>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <a
              href="https://instagram.com/beyonix.ar"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Abrir Instagram oficial de Beyonix"
              className="group flex cursor-pointer items-center gap-4 rounded-2xl border border-beyonix-blue-light/14 bg-beyonix-surface p-5 shadow-2xl shadow-black/25 transition-colors hover:border-beyonix-blue-light/50"
            >
              <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/28 bg-beyonix-blue/18 text-white transition-colors group-hover:border-beyonix-blue-light group-hover:bg-beyonix-blue">
                <Instagram className="size-5" />
              </div>

              <div>
                <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                  INSTAGRAM
                </p>
                <p className="mt-1 text-sm font-medium text-white/80">
                  beyonix.ar
                </p>
                <p className="mt-2 text-xs font-medium text-beyonix-cyan">
                  Abrir Instagram
                </p>
              </div>
            </a>

            <a
              href={GMAIL_COMPOSE_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Abrir Gmail para enviar email a Beyonix"
              className="group flex cursor-pointer items-center gap-4 rounded-2xl border border-beyonix-blue-light/14 bg-beyonix-surface p-5 text-left shadow-2xl shadow-black/25 transition-colors hover:border-beyonix-blue-light/50"
            >
              <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/28 bg-beyonix-blue/18 text-white transition-colors group-hover:border-beyonix-blue-light group-hover:bg-beyonix-blue">
                <Mail className="size-5" />
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                  EMAIL
                </p>
                <p className="mt-1 truncate text-sm font-medium text-white/80">
                  {BEYONIX_EMAIL}
                </p>
                <p className="mt-2 text-xs font-medium text-beyonix-cyan">
                  Abrir Gmail
                </p>
              </div>
            </a>

            {infoCards.map((item) => (
              <div
                key={item.label}
                className="flex items-center gap-4 rounded-2xl border border-beyonix-blue-light/14 bg-beyonix-surface p-5 shadow-2xl shadow-black/25"
              >
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/28 bg-beyonix-blue/18 text-white">
                  <item.icon className="size-5" />
                </div>

                <div>
                  <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                    {item.label}
                  </p>
                  <p className="mt-1 text-sm font-medium text-white/80">
                    {item.value}
                  </p>
                  {item.subValue ? (
                    <p className="mt-1 text-sm font-medium text-white/68">
                      {item.subValue}
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-2xl border border-beyonix-blue-light/16 bg-beyonix-surface p-6 shadow-2xl shadow-black/25">
            <p className="text-center text-sm font-semibold text-beyonix-blue-light">
              Tecnología pensada para tu comodidad.
            </p>
            <p className="mx-auto mt-2 max-w-3xl text-center text-base font-semibold leading-8 text-white/86">
              Una experiencia simple, clara y confiable en cada etapa de tu
              compra.
            </p>
          </div>

          <div className="mt-6 rounded-2xl border border-beyonix-blue-light/16 bg-beyonix-surface p-6 shadow-2xl shadow-black/25">
            <p className="text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
              ENVÍOS
            </p>

            <p className="mt-4 max-w-3xl text-base leading-8 text-white/76">
              Realizamos envíos a todo el país a través de Andreani,
              permitiéndote recibir tu compra de forma segura y confiable estés
              donde estés.
            </p>

            <p className="mt-3 max-w-3xl text-base leading-8 text-white/76">
              Una vez despachado el pedido, recibirás el número de seguimiento
              correspondiente para poder consultar el estado del envío en todo
              momento.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
