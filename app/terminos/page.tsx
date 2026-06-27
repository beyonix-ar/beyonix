export default function TerminosPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-4xl px-6 py-16 lg:px-8 lg:py-24">
          <p className="mb-3 text-11px font-medium uppercase tracking-widest text-beyonix-focus">
            BEYONIX
          </p>

          <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
            Términos y Condiciones
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/75">
            Al utilizar nuestro sitio web y realizar una compra en BEYONIX,
            aceptás los siguientes términos y condiciones.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-4xl space-y-12 px-6 py-14 lg:px-8 lg:py-20">
          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Información general
            </h2>

            <p className="leading-relaxed text-white/80">
              BEYONIX es un emprendimiento dedicado a la comercialización de
              productos tecnológicos y accesorios dentro del territorio de la
              República Argentina.
            </p>

            <p className="leading-relaxed text-white/80">
              Nos reservamos el derecho de actualizar, modificar o cambiar
              estos términos y condiciones en cualquier momento sin previo
              aviso.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Productos y disponibilidad
            </h2>

            <p className="leading-relaxed text-white/80">
              Todos los productos publicados están sujetos a disponibilidad de
              stock.
            </p>

            <p className="leading-relaxed text-white/80">
              Las imágenes utilizadas en el sitio son ilustrativas y pueden
              existir pequeñas diferencias visuales según el dispositivo desde
              el cual se visualicen.
            </p>

            <p className="leading-relaxed text-white/80">
              Todos los productos comercializados por BEYONIX son nuevos.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Precios
            </h2>

            <p className="leading-relaxed text-white/80">
              Todos los precios se encuentran expresados en pesos argentinos
              (ARS).
            </p>

            <p className="leading-relaxed text-white/80">
              Los precios y promociones pueden modificarse sin previo aviso.
            </p>

            <p className="leading-relaxed text-white/80">
              El precio válido será el informado al momento de confirmar la
              compra.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Métodos de pago
            </h2>

            <p className="leading-relaxed text-white/80">
              Actualmente aceptamos pagos mediante:
            </p>

            <ul className="list-disc space-y-2 pl-6 text-white/80">
              <li>Mercado Pago</li>
              <li>Transferencia bancaria</li>
              <li>Tarjetas de crédito y débito</li>
            </ul>

            <p className="leading-relaxed text-white/80">
              Todas las transacciones se realizan mediante plataformas seguras
              de terceros.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Envíos
            </h2>

            <p className="leading-relaxed text-white/80">
              Realizamos envíos a toda Argentina.
            </p>

            <p className="leading-relaxed text-white/80">
              Los pedidos son despachados dentro de un plazo máximo de 48 horas
              hábiles luego de acreditado el pago.
            </p>

            <p className="leading-relaxed text-white/80">
              Los tiempos de despacho pueden verse afectados durante fines de
              semana, feriados o fechas de alta demanda.
            </p>

            <p className="leading-relaxed text-white/80">
              Los envíos se realizan principalmente mediante Andreani y, en
              algunas zonas, mediante Correo Argentino.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Cambios y devoluciones
            </h2>

            <p className="leading-relaxed text-white/80">
              El cliente podrá solicitar cambios o devoluciones dentro de los 7
              días posteriores a la recepción del producto.
            </p>

            <p className="leading-relaxed text-white/80">
              Para que una devolución sea aceptada, el producto deberá
              encontrarse en perfectas condiciones, sin daños, golpes, marcas
              de uso ni faltantes.
            </p>

            <p className="leading-relaxed text-white/80">
              BEYONIX se reserva el derecho de rechazar devoluciones que no
              cumplan con estas condiciones.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Garantía
            </h2>

            <p className="leading-relaxed text-white/80">
              Todos nuestros productos cuentan con una garantía de 30 días
              corridos por fallas de funcionamiento de origen.
            </p>

            <p className="leading-relaxed text-white/80">
              La garantía no cubre daños ocasionados por mal uso, golpes,
              líquidos, modificaciones o manipulación indebida del producto.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Privacidad
            </h2>

            <p className="leading-relaxed text-white/80">
              La información personal brindada por los usuarios será utilizada
              únicamente para procesar compras, envíos y comunicaciones
              relacionadas con el servicio.
            </p>

            <p className="leading-relaxed text-white/80">
              BEYONIX no comercializa ni comparte datos personales con terceros
              ajenos al proceso de compra y logística.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Contacto
            </h2>

            <p className="leading-relaxed text-white/80">
              Para consultas, soporte o reclamos podés comunicarte mediante:
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