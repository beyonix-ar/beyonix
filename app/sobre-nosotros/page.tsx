import Link from "next/link"
import {
  ArrowRight,
  CheckCircle2,
  HeartHandshake,
  MapPin,
  Medal,
  PackageCheck,
  ShieldCheck,
  Sparkles,
} from "lucide-react"

const trustCards = [
  {
    title: "Elegimos con criterio",
    text: "No buscamos llenar un catálogo: seleccionamos productos útiles, modernos y pensados para resolver algo real.",
    icon: PackageCheck,
  },
  {
    title: "Comprás con tranquilidad",
    text: "Cuidamos que el proceso sea claro, seguro y acompañado desde que elegís hasta que recibís tu pedido.",
    icon: ShieldCheck,
  },
  {
    title: "Pensamos en los detalles",
    text: "La presentación, la comunicación y la experiencia importan tanto como el producto que llega a tus manos.",
    icon: Medal,
  },
]

const highlights = [
  "Base en Rosario, Santa Fe",
  "Envíos a todo el país",
  "Atención cercana y clara",
]

export default function SobreNosotrosPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="relative overflow-hidden bg-beyonix-page">
        <div className="mx-auto max-w-6xl px-6 pt-20 pb-14 lg:px-8 lg:pt-24 lg:pb-20">
          <div className="grid gap-8 lg:grid-cols-[1.04fr_0.96fr] lg:items-end">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-beyonix-blue-light/24 bg-beyonix-blue/18 px-3 py-1.5 text-11px font-semibold uppercase tracking-widest text-beyonix-cyan">
                <Sparkles className="size-3.5" />
                Nuestra historia
              </div>

              <h1 className="mt-5 max-w-3xl text-[clamp(2.6rem,5vw,4.9rem)] font-bold leading-[0.98] tracking-tight text-white">
                Sobre BEYONIX
              </h1>

              <p className="mt-5 max-w-2xl text-[clamp(1.15rem,2vw,1.55rem)] font-semibold leading-8 text-beyonix-sky">
                Conectados con tu comodidad, con productos que hacen tu día más simple.
              </p>
            </div>

            <div className="rounded-2xl border border-beyonix-blue-light/18 bg-beyonix-surface/78 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_24px_70px_rgba(0,0,0,0.32)]">
              <p className="text-sm font-semibold uppercase tracking-widest text-white/42">
                Lo que nos mueve
              </p>
              <p className="mt-3 text-lg leading-8 text-white/78">
                Queremos que comprar tecnología se sienta fácil, confiable y cercano. Que encuentres algo que te sirva, lo entiendas rápido y lo recibas con la tranquilidad de haber elegido bien.
              </p>
            </div>
          </div>

          <div className="mt-8 grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
            <article className="rounded-2xl border border-white/8 bg-[linear-gradient(135deg,rgba(15,23,42,0.72),rgba(10,10,10,0.98))] p-6 shadow-2xl shadow-black/30 sm:p-8 lg:p-10">
              <div className="max-w-3xl space-y-5 text-base leading-8 text-white/76">
                <p>
                  BEYONIX nace como una tienda online pensada para acercar productos útiles, modernos y funcionales a personas que valoran las soluciones simples.
                </p>

                <p>
                  Creemos que una buena compra no termina en el producto. También vive en la confianza, en la claridad de la información, en el cuidado de cada detalle y en la experiencia completa que hay detrás de cada elección.
                </p>

                <p>
                  Por eso seleccionamos con criterio, escuchamos lo que la gente necesita y trabajamos para que cada pedido se sienta ordenado, seguro y bien acompañado.
                </p>

                <p className="border-l border-beyonix-blue-light/45 pl-4 text-lg font-semibold leading-8 text-white">
                  BEYONIX es calidad, comodidad y una experiencia pensada para vos.
                </p>
              </div>
            </article>

            <aside className="grid gap-4">
              <div className="rounded-2xl border border-beyonix-blue-light/18 bg-beyonix-blue/18 p-5">
                <div className="flex items-center gap-3">
                  <span className="flex size-11 items-center justify-center rounded-xl border border-beyonix-blue-light/32 bg-black/24 text-beyonix-cyan">
                    <MapPin className="size-5" />
                  </span>
                  <div>
                    <p className="text-sm text-white/50">Desde</p>
                    <p className="text-lg font-bold text-white">Rosario</p>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-6 text-white/64">
                  Construimos una marca cercana, prolija y comprometida con llegar a cada rincón del país.
                </p>
              </div>

              <div className="rounded-2xl border border-white/8 bg-beyonix-surface p-5">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex size-11 items-center justify-center rounded-xl border border-beyonix-blue-light/28 bg-beyonix-blue/24 text-beyonix-cyan">
                    <HeartHandshake className="size-5" />
                  </span>
                  <p className="text-lg font-bold text-white">Cercanía real</p>
                </div>

                <ul className="space-y-3 text-sm text-white/64">
                  {highlights.map((highlight) => (
                    <li key={highlight} className="flex items-center gap-2">
                      <CheckCircle2 className="size-4 shrink-0 text-beyonix-cyan" />
                      <span>{highlight}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <Link
                href="/productos"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-beyonix-blue-light/40 bg-beyonix-blue px-5 py-3 text-sm font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-colors hover:border-beyonix-blue-light/70 hover:bg-beyonix-blue-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
              >
                Ver productos
                <ArrowRight className="size-4" />
              </Link>
            </aside>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            {trustCards.map((card) => (
              <article
                key={card.title}
                className="rounded-2xl border border-white/8 bg-beyonix-surface p-5 shadow-xl shadow-black/20 transition-colors hover:border-beyonix-blue-light/24 hover:bg-beyonix-surface-2"
              >
                <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-beyonix-blue-light/30 bg-beyonix-blue/30">
                  <card.icon className="size-5 text-beyonix-cyan" />
                </div>

                <h2 className="text-lg font-bold tracking-tight text-white">
                  {card.title}
                </h2>

                <p className="mt-3 text-sm leading-6 text-white/62">
                  {card.text}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
