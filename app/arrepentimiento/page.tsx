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
  BEYONIX_EMAIL,
  BEYONIX_SUPPORT_HOURS_DETAIL,
  BEYONIX_WITHDRAWAL_GMAIL_URL,
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
    value: "Confirmación del trámite",
    detail:
      "Te vamos a responder por el canal usado con las instrucciones para continuar.",
  },
]

export default function ArrepentimientoPage() {
  return (
    <main className="min-h-screen bg-transparent text-white">
      <section className="relative overflow-hidden border-b border-beyonix-blue-light/14">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(30,77,123,0.34),transparent_34%),radial-gradient(circle_at_86%_42%,rgba(24,91,128,0.15),transparent_30%),linear-gradient(180deg,rgba(3,8,14,0.66),rgba(0,0,0,0.9))]" />
        <div className="relative mx-auto max-w-6xl px-4 pb-12 pt-16 sm:px-6 sm:pb-14 sm:pt-20 lg:px-8 lg:pb-16 lg:pt-24">
          <span className="rounded-full border border-beyonix-blue-light/22 bg-beyonix-blue/16 px-3 py-1 text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">
            Compra online
          </span>

          <h1 className="mt-5 max-w-4xl text-4xl font-bold tracking-[-0.035em] text-white sm:text-5xl lg:text-6xl">
            Botón de arrepentimiento
          </h1>

          <p className="mt-5 max-w-3xl text-base leading-7 text-white/66 sm:text-lg sm:leading-8">
            Este acceso sirve para pedir la cancelación de una compra realizada online dentro del
            plazo legal. No es un reclamo por falla ni un cambio por preferencia: es el derecho a
            revocar una compra cuando corresponde.
          </p>

          <div className="mt-7 flex flex-col gap-2.5 sm:flex-row">
            <BeyonixButton asChild size="lg">
              <a
                href={BEYONIX_WITHDRAWAL_GMAIL_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Mail className="size-4" />
                Solicitar por Gmail
              </a>
            </BeyonixButton>
            <BeyonixButton asChild size="lg" variant="secondary">
              <Link href="/cuenta?tab=ordenes">
                Ver mis compras
                <ArrowRight className="size-4" />
              </Link>
            </BeyonixButton>
          </div>
        </div>
      </section>

      <section className="bg-black/92">
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
                  <CheckCircle2 className="mt-1 size-4 shrink-0 text-emerald-200" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <p className="mt-6 text-sm leading-6 text-white/52">
              Horario de atención: {BEYONIX_SUPPORT_HOURS_DETAIL}
            </p>
          </div>

          <div className="grid gap-3">
            {facts.map((fact) => (
              <div
                key={fact.label}
                className="rounded-xl border border-beyonix-blue-light/16 bg-beyonix-surface p-5"
              >
                <div className="flex items-start gap-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-beyonix-blue-light/28 bg-beyonix-blue/18 text-white">
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
