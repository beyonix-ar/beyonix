export default function DevolucionesPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-4xl px-6 py-16 lg:px-8 lg:py-24">
          <p className="mb-3 text-11px font-medium uppercase tracking-widest text-beyonix-focus">
            BEYONIX
          </p>

          <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
            Cambios y Devoluciones
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/75">
            Queremos que tengas la mejor experiencia posible con tu compra.
            Si existe algún inconveniente, podés solicitar un cambio o
            devolución bajo las siguientes condiciones.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-4xl space-y-12 px-6 py-14 lg:px-8 lg:py-20">
          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Plazo para solicitar cambios o devoluciones
            </h2>

            <p className="leading-relaxed text-white/80">
              El cliente podrá solicitar un cambio o devolución dentro de los
              7 días posteriores a la recepción del pedido.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Condiciones del producto
            </h2>

            <p className="leading-relaxed text-white/80">
              Para que una devolución sea aceptada, el producto deberá
              encontrarse en perfectas condiciones.
            </p>

            <ul className="list-disc space-y-2 pl-6 text-white/80">
              <li>Sin golpes ni daños físicos</li>
              <li>Sin marcas de uso</li>
              <li>Con todos sus accesorios</li>
              <li>Con embalaje original</li>
              <li>Sin faltantes</li>
            </ul>

            <p className="leading-relaxed text-white/80">
              BEYONIX se reserva el derecho de rechazar devoluciones que no
              cumplan con estas condiciones.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Productos con fallas
            </h2>

            <p className="leading-relaxed text-white/80">
              Si el producto presenta una falla de funcionamiento dentro de
              los primeros 30 días corridos desde la compra, podés comunicarte
              con nosotros para evaluar el caso.
            </p>

            <p className="leading-relaxed text-white/80">
              La garantía cubre únicamente fallas de origen y no daños
              ocasionados por golpes, líquidos, uso indebido o manipulación
              incorrecta.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Reembolsos
            </h2>

            <p className="leading-relaxed text-white/80">
              Una vez recibido y verificado el estado del producto, se
              procederá al reintegro correspondiente mediante el mismo método
              de pago utilizado en la compra, siempre que corresponda.
            </p>

            <p className="leading-relaxed text-white/80">
              Los tiempos de acreditación pueden variar según la entidad
              bancaria o plataforma de pago utilizada.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Envíos de devoluciones
            </h2>

            <p className="leading-relaxed text-white/80">
              En algunos casos, el cliente podrá ser responsable de los costos
              de envío asociados al cambio o devolución, salvo que exista una
              falla comprobable de origen.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Contacto
            </h2>

            <p className="leading-relaxed text-white/80">
              Para solicitar asistencia relacionada con cambios, devoluciones
              o garantías, podés escribirnos a:
            </p>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <p className="text-white">
                beyonix.ar@gmail.com
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}