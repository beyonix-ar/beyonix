export default function PrivacidadPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <section className="border-b border-white/10">
        <div className="mx-auto max-w-4xl px-6 py-16 lg:px-8 lg:py-24">
          <p className="mb-3 text-11px font-medium uppercase tracking-widest text-beyonix-focus">
            BEYONIX
          </p>

          <h1 className="text-4xl font-bold tracking-tight lg:text-5xl">
            Política de Privacidad
          </h1>

          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/75">
            En BEYONIX valoramos y respetamos la privacidad de nuestros
            usuarios. Esta política explica cómo recopilamos, utilizamos y
            protegemos tu información personal.
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-4xl space-y-12 px-6 py-14 lg:px-8 lg:py-20">
          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Información que recopilamos
            </h2>

            <p className="leading-relaxed text-white/80">
              Podemos recopilar información personal proporcionada por el
              usuario al realizar una compra, registrarse o comunicarse con
              nosotros.
            </p>

            <ul className="list-disc space-y-2 pl-6 text-white/80">
              <li>Nombre y apellido</li>
              <li>Correo electrónico</li>
              <li>Teléfono</li>
              <li>Dirección de envío</li>
              <li>Información relacionada con pedidos</li>
            </ul>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Uso de la información
            </h2>

            <p className="leading-relaxed text-white/80">
              La información recopilada es utilizada únicamente para:
            </p>

            <ul className="list-disc space-y-2 pl-6 text-white/80">
              <li>Procesar compras y pagos</li>
              <li>Gestionar envíos</li>
              <li>Brindar soporte al cliente</li>
              <li>Enviar información relacionada con pedidos</li>
              <li>Mejorar la experiencia del usuario</li>
            </ul>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Protección de datos
            </h2>

            <p className="leading-relaxed text-white/80">
              BEYONIX adopta medidas razonables de seguridad para proteger la
              información personal de accesos no autorizados, pérdidas o usos
              indebidos.
            </p>

            <p className="leading-relaxed text-white/80">
              Las transacciones de pago son procesadas mediante plataformas
              externas seguras como Mercado Pago.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Compartir información
            </h2>

            <p className="leading-relaxed text-white/80">
              BEYONIX no vende ni comparte información personal con terceros
              ajenos al proceso de compra, pago o envío.
            </p>

            <p className="leading-relaxed text-white/80">
              Algunos datos pueden ser compartidos únicamente con servicios
              logísticos o plataformas de pago para completar correctamente el
              pedido.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Cookies
            </h2>

            <p className="leading-relaxed text-white/80">
              Nuestro sitio puede utilizar cookies o tecnologías similares para
              mejorar la navegación y optimizar la experiencia del usuario.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Derechos del usuario
            </h2>

            <p className="leading-relaxed text-white/80">
              El usuario puede solicitar la modificación o eliminación de sus
              datos personales enviando una solicitud a nuestro correo de
              contacto.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Modificaciones
            </h2>

            <p className="leading-relaxed text-white/80">
              Nos reservamos el derecho de actualizar esta política de
              privacidad en cualquier momento sin previo aviso.
            </p>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-semibold">
              Contacto
            </h2>

            <p className="leading-relaxed text-white/80">
              Para consultas relacionadas con privacidad o datos personales,
              podés comunicarte mediante:
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