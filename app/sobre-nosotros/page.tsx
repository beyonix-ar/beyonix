import {
  CheckCircle2,
  Medal,
  ShieldCheck,
} from "lucide-react"

const trustCards = [
  {
    title: "Productos seleccionados con criterio",
    text: "Elegimos artículos prácticos, funcionales y pensados para aportar valor real en el uso diario.",
    icon: CheckCircle2,
  },
  {
    title: "Compra simple y segura",
    text: "Buscamos que cada paso sea claro, desde la elección del producto hasta la entrega.",
    icon: ShieldCheck,
  },
  {
    title: "Calidad y experiencia",
    text: "Trabajamos para ofrecer productos de calidad y una experiencia de compra cuidada, simple y confiable.",
    icon: Medal,
  },
]

export default function SobreNosotrosPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="bg-beyonix-page">
        <div className="mx-auto max-w-5xl px-6 pt-20 pb-10 lg:px-8 lg:pt-24 lg:pb-12">
          <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
            Sobre BEYONIX
          </h1>

          <p
            className="mt-4 max-w-2xl text-xl font-semibold"
            style={{ color: "#58B7E8" }}
          >
            Conectados con tu comodidad.
          </p>

          <div className="mt-8 rounded-2xl border border-white/8 bg-beyonix-surface p-6 shadow-2xl shadow-black/30 sm:p-8 lg:p-9">
            <div className="max-w-3xl space-y-4 text-base leading-8 text-white/78">
              <p>
                BEYONIX nace como una tienda online pensada para acercar productos útiles, modernos y funcionales a personas que buscan soluciones simples para su día a día.
              </p>

              <p>
                Creemos que una buena compra no depende solo del producto, sino también de la calidad, la confianza y la experiencia que hay detrás de cada elección.
              </p>

              <p>
                Por eso, nuestro foco está en seleccionar artículos con criterio, cuidar cada detalle de presentación y ofrecer una experiencia de compra simple, segura y diferente.
              </p>

              <p>
                Con base en Rosario, trabajamos para construir una marca cercana, ordenada y comprometida con ofrecer productos de calidad y una experiencia de compra pensada para tu comodidad.
              </p>

              <p className="font-semibold text-white">
                BEYONIX — Calidad, comodidad y una experiencia pensada para vos.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {trustCards.map((card) => (
              <article
                key={card.title}
                className="rounded-2xl border border-white/8 bg-beyonix-surface p-5 shadow-xl shadow-black/20"
              >
                <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-beyonix-blue-light/30 bg-beyonix-blue/35">
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
