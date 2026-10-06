import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Mail,
  ShieldCheck,
} from "lucide-react"

import { BeyonixButton } from "@/components/beyonix-ui"
import {
  BEYONIX_CUSTOMER_SERVICE_AREA,
  BEYONIX_EMAIL,
  BEYONIX_SUPPORT_HOURS_DETAIL,
  BEYONIX_WITHDRAWAL_GMAIL_URL,
  BEYONIX_WITHDRAWAL_URL,
} from "@/lib/legal-contact"

export const metadata: Metadata = {
  title: "Botón de arrepentimiento | BEYONIX",
  description:
    "Solicitá la cancelación de una compra online realizada en BEYONIX por derecho de arrepentimiento.",
}

const requirements = [
  "Nombre y apellido.",
  "Número de pedido.",
  "Correo utilizado en la compra.",
  "Producto que querés cancelar.",
]

const nextSteps = [
  "Dentro de las 24 horas te enviamos, al mismo correo, el código de identificación del trámite.",
  "Generamos la etiqueta de Andreani a cargo de BEYONIX y te indicamos cómo embalar el producto.",
  "Entregás el producto en una sucursal Andreani habilitada (no se realizan retiros a domicilio).",
  "Al recibirlo, reintegramos lo pagado por el medio de pago utilizado y, si hubo factura, emitimos la nota de crédito.",
]

const facts = [
  {
    icon: Clock3,
    label: "Plazo",
    value: "10 días corridos",
    detail:
      "Desde que recibís el producto o desde que confirmás la compra, lo que ocurra último.",
  },
  {
    icon: ShieldCheck,
    label: "Sin motivo",
    value: "No hace falta justificar",
    detail:
      "El trámite corresponde a compras online cuando el derecho resulte legalmente aplicable.",
  },
  {
    icon: CheckCircle2,
    label: "Respuesta",
    value: "Código en 24 h",
    detail:
      "Te vamos a responder por el mismo canal con una identificación del trámite.",
  },
]

export default function ArrepentimientoPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="relative overflow-hidden bg-beyonix-page border-b border-beyonix-blue-light/14">
        <div className="mx-auto max-w-6xl px-4 pb-12 pt-20 sm:px-6 sm:pb-14 lg:px-8 lg:pb-16 lg:pt-24">
          <span className="beyonix-history-badge inline-flex items-center gap-2 rounded-full border border-beyonix-blue-light/22 bg-beyonix-blue/16 px-3 py-1 text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">
            Compra online
          </span>

          <h1 className="mt-5 max-w-4xl text-4xl font-bold tracking-[-0.035em] text-[var(--beyonix-text-primary)] sm:text-5xl lg:text-6xl">
            Botón de arrepentimiento
          </h1>

          <p className="mt-5 max-w-3xl text-base font-medium leading-7 text-beyonix-sky sm:text-lg sm:leading-8">
            Este acceso sirve para pedir la cancelación de una compra realizada online dentro del
            plazo legal. No es un reclamo por falla ni un cambio por preferencia: es el derecho a
            revocar una compra cuando corresponde, sin iniciar sesión ni registrarte.
          </p>

          <div className="mt-7 flex flex-col gap-2.5 sm:flex-row">
            <BeyonixButton asChild size="lg">
              <a href={BEYONIX_WITHDRAWAL_URL}>
                <Mail className="size-4" />
                Solicitar por email
              </a>
            </BeyonixButton>
            <BeyonixButton asChild size="lg" variant="secondary">
              <a
                href={BEYONIX_WITHDRAWAL_GMAIL_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir en Gmail
                <ArrowRight className="size-4" />
              </a>
            </BeyonixButton>
          </div>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-white/58">
            No hace falta tener cuenta en BEYONIX. Si tu dispositivo no abre el email, escribí
            desde cualquier casilla a {BEYONIX_EMAIL}.
          </p>
        </div>
      </section>

      <section id="contenido" className="bg-beyonix-page">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:py-16">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-white">
              Datos necesarios para iniciar el trámite
            </h2>
            <p className="mt-4 text-base leading-7 text-white/66">
              Si preferís no usar Gmail, podés escribir directamente a{" "}
              <a
                href={`mailto:${BEYONIX_EMAIL}`}
                className="font-semibold text-beyonix-cyan underline-offset-4 hover:text-white hover:underline"
              >
                {BEYONIX_EMAIL}
              </a>{" "}
              con el asunto “Botón de arrepentimiento”.
            </p>

            <ul className="mt-6 space-y-3">
              {requirements.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6 text-white/74">
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-beyonix-cyan" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <p className="mt-4 text-sm leading-6 text-white/52">
              Si no tenés algún dato a mano (por ejemplo, el número de pedido), enviá la solicitud
              igual: lo identificamos con el correo de la compra.
            </p>

            <h2 className="mt-8 text-xl font-bold tracking-tight text-white">
              Qué pasa después
            </h2>
            <ul className="mt-4 space-y-3">
              {nextSteps.map((item) => (
                <li key={item} className="flex gap-3 text-sm leading-6 text-white/74">
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-beyonix-cyan" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <p className="mt-6 text-sm leading-6 text-white/52">
              {BEYONIX_CUSTOMER_SERVICE_AREA} · Horario de atención: {BEYONIX_SUPPORT_HOURS_DETAIL}
            </p>
            <p className="mt-2 text-sm leading-6 text-white/52">
              Excepciones (Disposición 954/2025): casos del art. 1116 del Código Civil y Comercial,
              productos efectivamente utilizados o consumidos, compras para reventa y productos
              perecederos. Ver el detalle en{" "}
              <Link
                href="/terminos#arrepentimiento"
                className="font-semibold text-beyonix-cyan underline-offset-4 hover:text-white hover:underline"
              >
                Términos y condiciones
              </Link>
              .
            </p>
          </div>

          <div className="grid gap-3">
            {facts.map((fact) => (
              <div
                key={fact.label}
                className="rounded-xl border border-beyonix-blue-light/16 bg-beyonix-surface p-5"
              >
                <div className="flex items-start gap-4">
                  <div className="beyonix-legal-icon-tile flex size-10 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/28 bg-beyonix-blue/18 text-white">
                    <fact.icon className="size-5" />
                  </div>
                  <div>
                    <p className="text-10px font-semibold uppercase tracking-[0.16em] text-beyonix-cyan">
                      {fact.label}
                    </p>
                    <p className="mt-1 font-bold text-white">{fact.value}</p>
                    <p className="mt-2 text-sm leading-6 text-white/62">{fact.detail}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
