import type { Metadata } from "next"
import Link from "next/link"
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  Mail,
  MessageCircleWarning,
  PackageCheck,
  RefreshCcw,
  ShieldCheck,
  Truck,
} from "lucide-react"

import { BeyonixButton, BeyonixCard, BeyonixIconBox } from "@/components/beyonix-ui"
import {
  BEYONIX_EMAIL,
  BEYONIX_WITHDRAWAL_URL,
} from "@/lib/legal-contact"
import { TRANSPORT_CLAIM_WINDOW_HOURS } from "@/lib/order-claims"
import { DEFAULT_PRODUCT_WARRANTY_MONTHS } from "@/lib/orders/warranty"

export const metadata: Metadata = {
  title: "Cambios y devoluciones | BEYONIX",
  description:
    "Cómo gestionar arrepentimientos, devoluciones, cambios, reclamos y garantías en BEYONIX.",
}

const facts = [
  {
    icon: RefreshCcw,
    label: "Arrepentimiento",
    value: "10 días corridos",
    detail: "Desde que recibe el producto o confirma la compra, lo que ocurra último.",
  },
  {
    icon: MessageCircleWarning,
    label: "Daño de transporte",
    value: `${TRANSPORT_CLAIM_WINDOW_HOURS} horas`,
    detail: "Canal prioritario desde el detalle del pedido para documentar el inconveniente.",
  },
  {
    icon: ShieldCheck,
    label: "Garantía legal",
    value: `${DEFAULT_PRODUCT_WARRANTY_MONTHS} meses`,
    detail: "Plazo mínimo para productos nuevos, contado desde la entrega.",
  },
]

const steps = [
  {
    number: "01",
    title: "Identificá la compra",
    description: "Ingresá al pedido y seleccioná el producto afectado. Si no podés acceder, escribinos con el número de orden y el email de compra.",
  },
  {
    number: "02",
    title: "Contanos qué ocurrió",
    description: "Elegí el motivo, describí el caso y adjuntá fotos, videos o documentos cuando ayuden a verificarlo.",
  },
  {
    number: "03",
    title: "Recibí las instrucciones",
    description: "BEYONIX analizará el pedido y te indicará por el chat la solución, el embalaje y el destino si corresponde devolverlo.",
  },
  {
    number: "04",
    title: "Seguimiento y cierre",
    description: "La conversación conservará el historial. Si hay reintegro, cambio o reparación, su avance quedará registrado en la compra.",
  },
]

function PolicyCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof RefreshCcw
  title: string
  children: React.ReactNode
}) {
  return (
    <BeyonixCard variant="information" className="p-5 sm:p-6">
      <div className="flex items-start gap-3.5">
        <BeyonixIconBox size="lg">
          <Icon className="size-5" />
        </BeyonixIconBox>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white sm:text-xl">{title}</h2>
          <div className="mt-3 space-y-3 text-sm leading-7 text-white/66">{children}</div>
        </div>
      </div>
    </BeyonixCard>
  )
}

export default function DevolucionesPage() {
  return (
    <main className="min-h-screen bg-transparent text-white">
      <section className="relative overflow-hidden border-b border-beyonix-blue-light/14">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_8%,rgba(30,77,123,0.34),transparent_34%),radial-gradient(circle_at_86%_42%,rgba(24,91,128,0.15),transparent_30%),linear-gradient(180deg,rgba(3,8,14,0.66),rgba(0,0,0,0.9))]" />
        <div className="relative mx-auto max-w-6xl px-4 pb-12 pt-16 sm:px-6 sm:pb-14 sm:pt-20 lg:px-8 lg:pb-16 lg:pt-24">
          <span className="rounded-full border border-beyonix-blue-light/22 bg-beyonix-blue/16 px-3 py-1 text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">
            Posventa BEYONIX
          </span>
          <h1 className="mt-5 max-w-4xl text-4xl font-bold tracking-[-0.035em] text-white sm:text-5xl lg:text-6xl">
            Cambios, devoluciones y garantía
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-white/66 sm:text-lg sm:leading-8">
            Cada situación tiene un circuito claro. Acá podés distinguir un arrepentimiento,
            un inconveniente con la entrega, una falla cubierta por garantía o un cambio voluntario.
          </p>
          <div className="mt-7 flex flex-col gap-2.5 sm:flex-row">
            <BeyonixButton asChild size="lg">
              <a href={BEYONIX_WITHDRAWAL_URL}>
                <RefreshCcw className="size-4" />
                Botón de arrepentimiento
              </a>
            </BeyonixButton>
            <BeyonixButton asChild size="lg" variant="secondary">
              <Link href="/cuenta/compras">
                Ver mis compras
                <ArrowRight className="size-4" />
              </Link>
            </BeyonixButton>
          </div>

          <div className="mt-10 grid gap-3 md:grid-cols-3">
            {facts.map((fact) => (
              <BeyonixCard key={fact.label} variant="information" className="p-4">
                <div className="flex items-start gap-3">
                  <BeyonixIconBox size="sm"><fact.icon className="size-4" /></BeyonixIconBox>
                  <div>
                    <p className="text-9px font-semibold uppercase tracking-[0.16em] text-white/42">{fact.label}</p>
                    <p className="mt-1 text-lg font-bold text-white">{fact.value}</p>
                    <p className="mt-1 text-xs leading-5 text-white/50">{fact.detail}</p>
                  </div>
                </div>
              </BeyonixCard>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <div className="grid gap-4 lg:grid-cols-2">
          <PolicyCard icon={RefreshCcw} title="Arrepentimiento de una compra a distancia">
            <p>
              Podés revocar la aceptación dentro de los 10 días corridos desde la entrega del
              producto o la confirmación de la compra, lo último que ocurra. La gestión no requiere
              justificar el motivo y, cuando el supuesto está legalmente alcanzado, la devolución
              es a cargo de BEYONIX.
            </p>
            <p>
              El producto debe quedar a disposición con sus accesorios y elementos recibidos.
              Conservá el embalaje siempre que sea posible. Se aplican únicamente las excepciones
              previstas por la normativa vigente.
            </p>
          </PolicyCard>

          <PolicyCard icon={Truck} title="Problemas con la entrega">
            <p>
              Si el paquete llega abierto, golpeado, con faltantes o con un producto incorrecto,
              iniciá el reclamo desde la compra durante las primeras {TRANSPORT_CLAIM_WINDOW_HOURS} horas.
              Ese aviso temprano permite preservar evidencia y reclamar al operador logístico.
            </p>
            <p>
              Guardá el embalaje, la etiqueta y todo el contenido. El plazo prioritario de transporte
              no reduce derechos legales irrenunciables.
            </p>
          </PolicyCard>

          <PolicyCard icon={ShieldCheck} title="Fallas y garantía legal">
            <p>
              Todos los productos nuevos vendidos por BEYONIX tienen una garantía de
              {` ${DEFAULT_PRODUCT_WARRANTY_MONTHS} meses`} desde la entrega.
            </p>
            <p>
              La cobertura comprende fallas de origen y defectos de funcionamiento. Los golpes
              posteriores, líquidos, conexiones inadecuadas, modificaciones o reparaciones no
              autorizadas se evalúan según su relación comprobable con la falla.
            </p>
          </PolicyCard>

          <PolicyCard icon={PackageCheck} title="Cambios voluntarios">
            <p>
              Un cambio por preferencia, color o modelo que no corresponda a arrepentimiento,
              garantía o error de entrega se evalúa según stock y estado del artículo. En estos casos
              puede existir una diferencia de precio o costo logístico, informado antes de avanzar.
            </p>
            <p>
              Para esta gestión comercial, el producto debe estar sin uso, completo, sin daños y con
              sus accesorios y embalaje. Estas condiciones no limitan los derechos legales aplicables.
            </p>
          </PolicyCard>
        </div>

        <section className="mt-8 rounded-2xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(8,17,27,0.94),rgba(5,8,12,0.98))] p-5 sm:p-7">
          <p className="text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">Cómo se gestiona</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">Un proceso trazable, de principio a fin</h2>
          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {steps.map((step) => (
              <div key={step.number} className="rounded-xl border border-white/8 bg-black/20 p-4">
                <span className="text-10px font-bold tracking-[0.18em] text-beyonix-cyan">{step.number}</span>
                <h3 className="mt-2 font-bold text-white">{step.title}</h3>
                <p className="mt-2 text-xs leading-6 text-white/55">{step.description}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          <PolicyCard icon={Clock3} title="Reintegros y tiempos de acreditación">
            <p>
              Una vez aprobada la devolución y cumplida la restitución cuando corresponda, el
              reintegro se procesa por el medio compatible con el pago original. Si hubo factura,
              se emite la nota de crédito aplicable.
            </p>
            <p>
              BEYONIX registra el inicio del reintegro; la acreditación final puede depender de
              Mercado Pago, la entidad bancaria, la tarjeta o el ciclo de cierre del medio utilizado.
            </p>
          </PolicyCard>

          <PolicyCard icon={CheckCircle2} title="Recepción e inventario">
            <p>
              Cuando un producto vuelve físicamente, BEYONIX registra su recepción y condición.
              Las unidades aptas para reventa regresan al stock; las dañadas o incompletas quedan
              asentadas como baja o pérdida y no vuelven a ofrecerse.
            </p>
            <p>
              Esta clasificación es interna y no modifica una solución ya reconocida al cliente.
              El historial del reclamo permanece disponible una vez cerrado.
            </p>
          </PolicyCard>
        </div>

        <section className="mt-8 rounded-2xl border border-beyonix-blue-light/26 bg-[radial-gradient(circle_at_10%_0%,rgba(44,108,163,0.22),transparent_38%),linear-gradient(145deg,rgba(17,42,67,0.42),rgba(5,9,14,0.98))] p-6 sm:p-7">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-2xl">
              <p className="text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">Canal de asistencia</p>
              <h2 className="mt-2 text-2xl font-bold text-white">¿No encontrás la gestión en tu pedido?</h2>
              <p className="mt-2 text-sm leading-6 text-white/60">Escribinos a {BEYONIX_EMAIL} con el número de orden y el correo usado en la compra.</p>
            </div>
            <div className="flex shrink-0 flex-col gap-2 sm:items-end">
              <BeyonixButton asChild><a href={`mailto:${BEYONIX_EMAIL}`}><Mail className="size-4" />Contactar</a></BeyonixButton>
              <BeyonixButton asChild variant="secondary"><Link href="/terminos">Ver términos completos</Link></BeyonixButton>
            </div>
          </div>
        </section>
      </section>
    </main>
  )
}
