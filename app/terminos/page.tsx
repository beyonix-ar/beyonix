import type { Metadata } from "next"
import Link from "next/link"
import type { LucideIcon } from "lucide-react"
import {
  BadgeDollarSign,
  CheckCircle2,
  Clock3,
  Copyright,
  CreditCard,
  FileCheck2,
  FileText,
  Fingerprint,
  Instagram,
  Landmark,
  LockKeyhole,
  Mail,
  MessageCircleWarning,
  PackageCheck,
  ReceiptText,
  RefreshCcw,
  Scale,
  ShieldCheck,
  ShoppingBag,
  Truck,
  UserRoundCheck,
  Wrench,
} from "lucide-react"

import { BeyonixButton, BeyonixCard, BeyonixIconBox } from "@/components/beyonix-ui"
import {
  BEYONIX_EMAIL,
  BEYONIX_INSTAGRAM_URL,
  BEYONIX_SUPPORT_HOURS_DETAIL,
} from "@/lib/legal-contact"
import {
  getSiteSettings,
} from "@/lib/site-settings"
import {
  PAYMENT_PROOF_ALLOWED_EXTENSIONS,
  PAYMENT_PROOF_MAX_SIZE,
  TRANSFER_DISCOUNT_PERCENT,
} from "@/lib/payments/transfer"
import { TRANSPORT_CLAIM_WINDOW_HOURS } from "@/lib/order-claims"
import { DEFAULT_PRODUCT_WARRANTY_MONTHS } from "@/lib/orders/warranty"
import { TRANSFER_PAYMENT_EXPIRATION_HOURS } from "@/lib/orders/transfer-expiration"

export const metadata: Metadata = {
  title: "Términos y condiciones | BEYONIX",
  description:
    "Condiciones de compra, pagos, envíos, devoluciones, reclamos, garantías y privacidad de BEYONIX.",
}

export const dynamic = "force-dynamic"

const LAST_UPDATED = "20 de julio de 2026"
const PAYMENT_PROOF_MAX_MB = PAYMENT_PROOF_MAX_SIZE / 1024 / 1024

const LEGAL_SECTIONS = [
  { id: "alcance", label: "Alcance y aceptación" },
  { id: "identidad", label: "Identidad y contacto" },
  { id: "cuenta", label: "Cuenta y acceso" },
  { id: "productos", label: "Productos y stock" },
  { id: "precios", label: "Precios y beneficios" },
  { id: "pagos", label: "Pagos y validación" },
  { id: "pedidos", label: "Pedidos y facturación" },
  { id: "envios", label: "Envíos y entrega" },
  { id: "arrepentimiento", label: "Arrepentimiento" },
  { id: "reclamos", label: "Reclamos y soluciones" },
  { id: "garantia", label: "Garantía" },
  { id: "privacidad", label: "Privacidad y seguridad" },
  { id: "propiedad", label: "Propiedad intelectual" },
  { id: "vigencia", label: "Vigencia y normativa" },
]

function formatARS(value: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(value)
}

function LegalSection({
  id,
  number,
  eyebrow,
  title,
  icon: Icon,
  children,
}: {
  id: string
  number: string
  eyebrow: string
  title: string
  icon: LucideIcon
  children: React.ReactNode
}) {
  return (
    <article
      id={id}
      className="scroll-mt-24 rounded-2xl border border-beyonix-blue-light/16 bg-[linear-gradient(145deg,rgba(8,17,27,0.94),rgba(5,8,12,0.98))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_24px_60px_rgba(0,0,0,0.22)] sm:p-6 lg:p-7"
    >
      <div className="flex items-start gap-3.5">
        <BeyonixIconBox size="lg" className="mt-0.5">
          <Icon className="size-5" />
        </BeyonixIconBox>
        <div className="min-w-0">
          <p className="text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan/80">
            {number} · {eyebrow}
          </p>
          <h2 className="mt-1.5 text-xl font-bold tracking-tight text-white sm:text-2xl">
            {title}
          </h2>
        </div>
      </div>
      <div className="mt-5 space-y-4 text-sm leading-7 text-white/68 sm:text-[15px]">
        {children}
      </div>
    </article>
  )
}

function LegalList({ children }: { children: React.ReactNode }) {
  return <ul className="grid gap-2.5">{children}</ul>
}

function LegalListItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2 className="mt-1.5 size-3.5 shrink-0 text-beyonix-cyan" />
      <span>{children}</span>
    </li>
  )
}

function KeyFact({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail: string
}) {
  return (
    <BeyonixCard variant="information" className="p-4">
      <div className="flex items-start gap-3">
        <BeyonixIconBox size="sm" className="mt-0.5">
          <Icon className="size-4" />
        </BeyonixIconBox>
        <div>
          <p className="text-9px font-semibold uppercase tracking-[0.16em] text-white/42">
            {label}
          </p>
          <p className="mt-1 text-base font-bold text-white">{value}</p>
          <p className="mt-1 text-xs leading-5 text-white/50">{detail}</p>
        </div>
      </div>
    </BeyonixCard>
  )
}

export default async function TerminosPage() {
  const siteSettings = await getSiteSettings()
  const shippingSettings = siteSettings.shipping
  const isShippingBonusEnabled = shippingSettings.freeShippingMode === "full"
  const shippingBenefitText = isShippingBonusEnabled
    ? `Desde ${formatARS(shippingSettings.freeShippingMinAmount)}`
    : "Según promoción vigente"

  return (
    <main className="min-h-screen bg-transparent text-white">
      <section className="relative overflow-hidden border-b border-beyonix-blue-light/14">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_22%_5%,rgba(30,77,123,0.34),transparent_34%),radial-gradient(circle_at_82%_38%,rgba(24,91,128,0.16),transparent_32%),linear-gradient(180deg,rgba(3,8,14,0.66),rgba(0,0,0,0.9))]" />
        <div className="relative mx-auto max-w-7xl px-4 pb-12 pt-16 sm:px-6 sm:pb-14 sm:pt-20 lg:px-8 lg:pb-16 lg:pt-24">
          <div className="max-w-4xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-beyonix-blue-light/22 bg-beyonix-blue/16 px-3 py-1 text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">
                Marco de compra BEYONIX
              </span>
              <span className="rounded-full border border-white/8 bg-black/25 px-3 py-1 text-10px font-medium uppercase tracking-[0.14em] text-white/48">
                Actualizado el {LAST_UPDATED}
              </span>
            </div>

            <h1 className="mt-5 max-w-4xl text-4xl font-bold tracking-[-0.035em] text-white sm:text-5xl lg:text-6xl">
              Términos y condiciones
            </h1>
            <p className="mt-5 max-w-3xl text-base leading-7 text-white/66 sm:text-lg sm:leading-8">
              Información clara sobre cómo funciona una compra en BEYONIX: precios, pagos,
              envíos, cancelaciones, devoluciones, reclamos, garantía, privacidad y derechos
              de las personas consumidoras.
            </p>

            <div className="mt-7 flex flex-col gap-2.5 sm:flex-row">
              <BeyonixButton asChild size="lg">
                <a href="#contenido">Consultar las condiciones</a>
              </BeyonixButton>
            </div>
          </div>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <KeyFact
              icon={RefreshCcw}
              label="Arrepentimiento"
              value="10 días corridos"
              detail="Desde que recibe el producto o confirma la compra, lo que ocurra último."
            />
            <KeyFact
              icon={MessageCircleWarning}
              label="Daño de transporte"
              value={`${TRANSPORT_CLAIM_WINDOW_HOURS} horas`}
              detail="Canal prioritario con evidencia desde el pedido."
            />
            <KeyFact
              icon={ShieldCheck}
              label="Garantía legal"
              value={`${DEFAULT_PRODUCT_WARRANTY_MONTHS} meses`}
              detail="Para productos nuevos, contados desde la entrega."
            />
            <KeyFact
              icon={BadgeDollarSign}
              label="Transferencia"
              value={`${TRANSFER_DISCOUNT_PERCENT}% OFF`}
              detail="Sobre productos; el envío se calcula por separado."
            />
            <KeyFact
              icon={Clock3}
              label="Comprobante"
              value={`${TRANSFER_PAYMENT_EXPIRATION_HOURS} horas`}
              detail="Plazo para subirlo antes de la cancelación automática."
            />
            <KeyFact
              icon={Truck}
              label="Envío bonificado"
              value={shippingBenefitText}
              detail={
                isShippingBonusEnabled
                  ? `Bonificación de hasta ${formatARS(shippingSettings.shippingBonusMax)}.`
                  : "Se informa, si corresponde, antes de pagar."
              }
            />
          </div>
        </div>
      </section>

      <section id="contenido" className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <div className="grid items-start gap-7 lg:grid-cols-[17rem_minmax(0,1fr)] xl:gap-10">
          <aside className="lg:sticky lg:top-24">
            <BeyonixCard variant="information" className="overflow-hidden p-3">
              <div className="border-b border-white/7 px-3 pb-3 pt-2">
                <p className="text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">
                  Índice del documento
                </p>
                <p className="mt-1 text-xs leading-5 text-white/46">
                  Navegá directamente al tema que necesitás.
                </p>
              </div>
              <nav aria-label="Índice de términos y condiciones" className="mt-2 grid gap-0.5">
                {LEGAL_SECTIONS.map((section, index) => (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="group flex items-center gap-3 rounded-lg px-3 py-2 text-xs font-semibold text-white/58 transition hover:bg-beyonix-blue/22 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25"
                  >
                    <span className="w-5 text-10px font-semibold text-beyonix-cyan/55 group-hover:text-beyonix-cyan">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {section.label}
                  </a>
                ))}
              </nav>
            </BeyonixCard>

            <div className="mt-3 rounded-xl border border-emerald-300/16 bg-emerald-400/7 p-4">
              <div className="flex items-start gap-2.5">
                <Scale className="mt-0.5 size-4 shrink-0 text-emerald-200" />
                <p className="text-xs font-medium leading-5 text-emerald-50/72">
                  Ninguna cláusula limita derechos reconocidos por normas de orden público o
                  de defensa del consumidor.
                </p>
              </div>
            </div>
          </aside>

          <div className="min-w-0 space-y-4">
            <LegalSection
              id="alcance"
              number="01"
              eyebrow="Documento contractual"
              title="Alcance y aceptación"
              icon={FileCheck2}
            >
              <p>
                Estos términos regulan el acceso al sitio, la creación de una cuenta y las
                compras realizadas en BEYONIX dentro de la República Argentina. Al
                confirmar una compra, la persona declara haber revisado la descripción del
                producto, el precio, el medio de pago, el tipo de envío y el resumen final.
              </p>
              <p>
                La publicación de un producto constituye una invitación a comprar. La operación
                queda sujeta a la validación del pago, los datos suministrados y la disponibilidad
                real de stock. La confirmación del pedido se identifica mediante un código único
                visible en la cuenta y en las comunicaciones asociadas.
              </p>
              <p>
                Si alguna disposición fuera incompatible con una norma obligatoria, prevalecerá
                esa norma sin afectar la validez del resto del documento. Las condiciones
                particulares informadas en una publicación o promoción integran estos términos.
              </p>
            </LegalSection>

            <LegalSection
              id="identidad"
              number="02"
              eyebrow="Canales oficiales"
              title="Identidad comercial y contacto"
              icon={Fingerprint}
            >
              <p>
                BEYONIX es una tienda online de productos tecnológicos y accesorios, con base
                operativa en Rosario, Santa Fe. Los datos fiscales y de facturación propios de
                cada operación constan en el comprobante emitido cuando corresponde.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <a
                  href={`mailto:${BEYONIX_EMAIL}`}
                  className="flex items-center gap-3 rounded-xl border border-beyonix-blue-light/16 bg-black/20 p-4 transition hover:border-beyonix-blue-light/42"
                >
                  <Mail className="size-5 text-beyonix-cyan" />
                  <span><strong className="block text-sm text-white">Email</strong><span className="text-xs text-white/52">{BEYONIX_EMAIL}</span></span>
                </a>
                <a
                  href={BEYONIX_INSTAGRAM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-xl border border-beyonix-blue-light/16 bg-black/20 p-4 transition hover:border-beyonix-blue-light/42"
                >
                  <Instagram className="size-5 text-beyonix-cyan" />
                  <span><strong className="block text-sm text-white">Instagram oficial</strong><span className="text-xs text-white/52">@beyonix.ar</span></span>
                </a>
              </div>
              <p>
                Los mensajes pueden enviarse en cualquier momento. La atención digital se realiza
                {` ${BEYONIX_SUPPORT_HOURS_DETAIL}`} Cuando exista un pedido, también se utilizará
                su conversación interna. BEYONIX nunca solicitará contraseñas ni datos completos
                de tarjetas por email, chat o redes sociales.
              </p>
            </LegalSection>

            <LegalSection
              id="cuenta"
              number="03"
              eyebrow="Uso responsable"
              title="Cuenta, acceso y permisos"
              icon={UserRoundCheck}
            >
              <LegalList>
                <LegalListItem>Los datos de registro, contacto, facturación y entrega deben ser reales, completos y estar actualizados.</LegalListItem>
                <LegalListItem>Las compras deben ser realizadas por personas con capacidad legal para contratar o con autorización de una persona adulta responsable.</LegalListItem>
                <LegalListItem>Cada persona es responsable de mantener la confidencialidad de su contraseña y de cerrar sesión en dispositivos compartidos.</LegalListItem>
                <LegalListItem>La cuenta permite consultar únicamente compras, comprobantes, mensajes, reclamos, beneficios y saldos asociados a su titular.</LegalListItem>
                <LegalListItem>Las funciones administrativas están restringidas a personal autorizado mediante permisos internos y trazabilidad de acciones.</LegalListItem>
                <LegalListItem>No está permitido intentar acceder a información ajena, alterar precios o stock, abusar de promociones, automatizar operaciones maliciosas ni interferir con la seguridad del sitio.</LegalListItem>
              </LegalList>
              <p>
                BEYONIX podrá limitar preventivamente una cuenta ante indicios objetivos de fraude,
                suplantación, uso abusivo o riesgo de seguridad, procurando informar el motivo y
                habilitar un canal de revisión. Esta facultad no afecta derechos derivados de
                compras correctamente confirmadas.
              </p>
            </LegalSection>

            <LegalSection
              id="productos"
              number="04"
              eyebrow="Catálogo"
              title="Productos, variantes y disponibilidad"
              icon={ShoppingBag}
            >
              <p>
                Las publicaciones describen nombre, imágenes, variante, color, características,
                precio y stock disponible. Las imágenes son ilustrativas: pueden existir diferencias
                mínimas de color por iluminación o pantalla, sin alterar las características
                esenciales informadas.
              </p>
              <LegalList>
                <LegalListItem>Los productos se comercializan como 100% nuevos y sin uso.</LegalListItem>
                <LegalListItem>La disponibilidad depende del producto y, cuando exista, de la variante seleccionada.</LegalListItem>
                <LegalListItem>Agregar un artículo al carrito no garantiza su reserva definitiva; el stock vuelve a verificarse al crear la orden.</LegalListItem>
                <LegalListItem>Ante una diferencia excepcional de stock, BEYONIX contactará al cliente para ofrecer una solución o reintegro, según corresponda.</LegalListItem>
              </LegalList>
              <p>
                Las reseñas y contenidos aportados por usuarios deben ser auténticos y respetuosos.
                Podrán moderarse contenidos ilícitos, ofensivos, falsos, publicitarios o ajenos al
                producto, sin alterar opiniones legítimas sobre la experiencia de compra.
              </p>
            </LegalSection>

            <LegalSection
              id="precios"
              number="05"
              eyebrow="Condiciones comerciales"
              title="Precios, promociones y beneficios"
              icon={BadgeDollarSign}
            >
              <p>
                Los importes se expresan en pesos argentinos (ARS). El precio aplicable es el que
                figura en el resumen final al confirmar la compra. Un cambio posterior del catálogo
                no modifica una operación ya confirmada.
              </p>
              <LegalList>
                <LegalListItem>Las ofertas pueden estar limitadas por tiempo, stock, producto, categoría o alcance informado.</LegalListItem>
                <LegalListItem>Los cupones y el descuento por transferencia no son acumulables sobre el mismo importe, salvo que el cupón indique expresamente lo contrario.</LegalListItem>
                <LegalListItem>Las gift cards y el saldo a favor funcionan como medio de pago. Pueden combinarse con cupones o transferencia, siempre que estén vigentes y asociados a la cuenta.</LegalListItem>
                <LegalListItem>Si una compra combina gift card o saldo a favor con transferencia, el descuento por transferencia se calcula únicamente sobre el importe restante de productos efectivamente abonado por transferencia.</LegalListItem>
                <LegalListItem>El costo de envío nunca recibe el descuento por transferencia.</LegalListItem>
                <LegalListItem>Las gift cards tienen una vigencia de 12 meses desde su acreditación. Vencido ese plazo, dejan de computar como saldo disponible.</LegalListItem>
                <LegalListItem>Los beneficios asignados a una cuenta son personales, se validan al pagar y pueden tener condiciones o vencimiento visibles antes de utilizarlos.</LegalListItem>
                <LegalListItem>Los errores manifiestos de publicación serán revisados antes de confirmar la operación y nunca habilitan cobros distintos de los aceptados por el cliente.</LegalListItem>
              </LegalList>
              {isShippingBonusEnabled && (
                <div className="rounded-xl border border-beyonix-blue-light/18 bg-beyonix-blue/10 p-4 text-white/72">
                  <strong className="text-white">Envío bonificado vigente.</strong>{" "}
                  Desde un subtotal de productos de {formatARS(shippingSettings.freeShippingMinAmount)}, BEYONIX
                  bonifica hasta {formatARS(shippingSettings.shippingBonusMax)} del costo logístico. Si el envío
                  supera ese tope, la diferencia queda informada antes de pagar.
                </div>
              )}
            </LegalSection>

            <LegalSection
              id="pagos"
              number="06"
              eyebrow="Operación segura"
              title="Métodos de pago y validación"
              icon={CreditCard}
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-white/8 bg-black/22 p-4">
                  <div className="flex items-center gap-2.5"><CreditCard className="size-4 text-beyonix-cyan" /><strong className="text-white">Mercado Pago</strong></div>
                  <p className="mt-2 text-xs leading-6 text-white/58">Permite pagar con saldo disponible o tarjeta. La aprobación, rechazo y acreditación dependen de Mercado Pago y de la entidad emisora. BEYONIX no almacena los datos completos de la tarjeta.</p>
                </div>
                <div className="rounded-xl border border-white/8 bg-black/22 p-4">
                  <div className="flex items-center gap-2.5"><Landmark className="size-4 text-beyonix-cyan" /><strong className="text-white">Transferencia bancaria</strong></div>
                  <p className="mt-2 text-xs leading-6 text-white/58">Aplica un {TRANSFER_DISCOUNT_PERCENT}% de descuento sobre el importe de productos que efectivamente se pague por transferencia. El envío y otros conceptos se calculan por separado.</p>
                </div>
              </div>
              <p>
                En pagos por transferencia, <strong className="font-bold text-white">el comprobante debe cargarse dentro de las
                {` ${TRANSFER_PAYMENT_EXPIRATION_HOURS} horas`} desde la creación del pedido</strong>. Si no
                se recibe dentro de ese plazo, la orden puede cancelarse automáticamente y liberar
                el stock. Se aceptan archivos {PAYMENT_PROOF_ALLOWED_EXTENSIONS.map((item) => item.toUpperCase()).join(", ")}
                {` de hasta ${PAYMENT_PROOF_MAX_MB} MB`}.
              </p>
              <p>
                <strong className="font-bold text-white">La carga del comprobante NO equivale a pago confirmado:</strong> BEYONIX verifica importe,
                destino y acreditación antes de aprobarlo. Si fuera rechazado, el estado del pedido
                indicará que debe reemplazarse. Los saldos a favor pueden cubrir total o parcialmente
                una compra cuando estén vigentes y asociados a la cuenta.
              </p>
            </LegalSection>

            <LegalSection
              id="pedidos"
              number="07"
              eyebrow="Ciclo de la compra"
              title="Confirmación, cancelación y facturación"
              icon={ReceiptText}
            >
              <LegalList>
                <LegalListItem>El pedido avanza una vez validado el pago o acreditado el saldo a favor aplicable.</LegalListItem>
                <LegalListItem>Antes del despacho, el cliente puede solicitar la cancelación desde el detalle de la compra, siempre que todavía no exista envío creado o movimiento logístico.</LegalListItem>
                <LegalListItem>Si el pago ya fue confirmado, la cancelación genera un reintegro pendiente. BEYONIX iniciará la gestión dentro de un máximo de 5 días hábiles desde la aprobación del caso y el cumplimiento de las condiciones aplicables.</LegalListItem>
                <LegalListItem>BEYONIX emite comprobantes a consumidor final. Si existe factura y corresponde revertir la operación, se emitirá la nota de crédito aplicable.</LegalListItem>
                <LegalListItem>La factura electrónica autorizada por ARCA queda disponible desde la cuenta cuando finaliza su emisión.</LegalListItem>
              </LegalList>
              <p>
                El cliente debe proporcionar nombre, DNI, email y domicilio correctos para la
                documentación como consumidor final y el envío. BEYONIX podrá cancelar una orden por falta de pago,
                imposibilidad objetiva de validación, fraude comprobable o indisponibilidad
                sobreviniente, restituyendo íntegramente cualquier importe cobrado.
              </p>
            </LegalSection>

            <LegalSection
              id="envios"
              number="08"
              eyebrow="Logística"
              title="Envíos, seguimiento y recepción"
              icon={Truck}
            >
              <p>
                BEYONIX realiza envíos dentro de la República Argentina mediante Andreani como
                operador principal. Ante inconvenientes operativos, falta de cobertura o necesidad
                logística, BEYONIX podrá utilizar otro operador de envío. En el checkout pueden
                ofrecerse entrega a domicilio o retiro en sucursal, según cobertura. El costo final
                se informa antes de confirmar el pago.
              </p>
              <LegalList>
                <LegalListItem>El despacho se prepara dentro de un máximo de 48 horas hábiles desde la acreditación del pago, salvo aviso particular o fuerza mayor.</LegalListItem>
                <LegalListItem>El tiempo de tránsito depende del destino, la modalidad, la operación del transportista, fines de semana, feriados y eventos de fuerza mayor.</LegalListItem>
                <LegalListItem>El seguimiento se informa en el detalle del pedido cuando existe número o enlace disponible.</LegalListItem>
                <LegalListItem>El cliente debe revisar destinatario, teléfono, código postal, localidad, provincia, calle, número y referencias antes de pagar.</LegalListItem>
                <LegalListItem>Una visita fallida, un retiro vencido o datos incorrectos pueden generar devolución al remitente y necesidad de coordinar un nuevo despacho.</LegalListItem>
                <LegalListItem>Si el inconveniente se debe a datos incorrectos o incompletos cargados por el cliente, BEYONIX no se hace responsable por costos, demoras o reenvíos derivados de ese error.</LegalListItem>
              </LegalList>
              <p>
                Al recibir, se recomienda revisar el embalaje y conservarlo mientras se verifica el
                contenido. Si llega abierto, golpeado, con un producto incorrecto o con unidades
                faltantes, el canal prioritario de transporte está disponible durante las primeras
                {` ${TRANSPORT_CLAIM_WINDOW_HOURS} horas`} desde la entrega. Este plazo operativo
                facilita la prueba frente al transportista y no reduce derechos legales irrenunciables.
              </p>
            </LegalSection>

            <LegalSection
              id="arrepentimiento"
              number="09"
              eyebrow="Compra a distancia"
              title="Derecho de arrepentimiento y devoluciones"
              icon={RefreshCcw}
            >
              <div className="rounded-xl border border-white/8 bg-black/22 p-4">
                <p className="text-sm font-semibold leading-7 text-white/72">
                  En compras online, el derecho de arrepentimiento puede ejercerse dentro de los 10 días corridos desde la entrega o la confirmación de la compra, lo que ocurra último, cuando resulte legalmente aplicable.
                </p>
              </div>

              <div>
                <h3 className="font-bold text-white">¿Cuándo corresponde?</h3>
                <p className="mt-2">
                  Permite revocar una compra online sin indicar motivo. El producto debe quedar a disposición de BEYONIX con sus accesorios y elementos recibidos.
                </p>
                <p className="mt-2">
                  El Botón de arrepentimiento puede usarse sin iniciar sesión. BEYONIX responderá por el mismo medio con la identificación del trámite.
                </p>
              </div>

              <div className="rounded-xl border border-white/8 bg-black/22 p-4">
                <div className="flex items-start gap-3">
                  <MessageCircleWarning className="mt-0.5 size-4 shrink-0 text-white/44" />
                  <div>
                    <h3 className="font-bold text-white">
                      Importante: no es un período de prueba
                    </h3>
                    <p className="mt-2 text-white/64">
                      No aplica si el producto fue usado, consumido o se encuentra dentro de una excepción legal.
                    </p>
                    <p className="mt-3 border-t border-white/8 pt-3 text-white/64">
                      BEYONIX podrá verificar la operación, el plazo y el estado del producto antes de coordinar la restitución.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="font-bold text-white">Cambios por preferencia</h3>
                <p className="mt-2">
                  Los cambios voluntarios por color, modelo o preferencia personal son diferentes al
                  derecho de arrepentimiento y estarán sujetos al estado del producto, disponibilidad
                  de stock y políticas comerciales de BEYONIX. En estos casos, el costo de envío o
                  reenvío queda a cargo del cliente, salvo que BEYONIX indique lo contrario.
                </p>
              </div>
            </LegalSection>

            <LegalSection
              id="reclamos"
              number="10"
              eyebrow="Atención posventa"
              title="Reclamos, evidencia y soluciones"
              icon={MessageCircleWarning}
            >
              <p>
                Antes de la entrega, el cliente puede enviar consultas desde el pedido. Después de
                la entrega, puede iniciar un reclamo seleccionando el producto afectado, el motivo y
                una descripción. Las fotos, videos o documentos ayudan a evaluar el caso y pueden
                agregarse mientras la conversación permanezca abierta.
              </p>
              <LegalList>
                <LegalListItem>Daño de transporte, paquete abierto o producto golpeado: aviso prioritario dentro de {TRANSPORT_CLAIM_WINDOW_HOURS} horas.</LegalListItem>
                <LegalListItem>Producto incorrecto, faltante o cantidad menor: identificar los artículos y conservar el embalaje recibido.</LegalListItem>
                <LegalListItem>Falla de funcionamiento: describir síntomas, momento de inicio y pruebas realizadas sin desarmar ni modificar el producto.</LegalListItem>
                <LegalListItem>La conversación y la evidencia permanecen disponibles como historial una vez finalizado el reclamo.</LegalListItem>
              </LegalList>
              <p>
                Según el caso y la normativa aplicable, la resolución puede consistir en reparación,
                cambio de producto, envío de una unidad faltante, reintegro total o parcial, saldo a
                favor, beneficio comercial u otra solución acordada. Toda negativa debe responder a
                una evaluación fundada; el cliente conserva sus vías legales de reclamo.
              </p>
              <p>
                Cuando corresponda un reintegro, BEYONIX iniciará la gestión dentro de un máximo de
                5 días hábiles desde la aprobación del caso. La acreditación final puede depender del
                medio de pago, la entidad bancaria, Mercado Pago o los ciclos de cierre aplicables.
              </p>
              <p>
                Cuando BEYONIX solicite la devolución física, informará por el chat el destino y las
                instrucciones de embalaje.
              </p>
            </LegalSection>

            <LegalSection
              id="garantia"
              number="11"
              eyebrow="Protección del producto"
              title="Garantía legal y fallas de origen"
              icon={Wrench}
            >
              <p>
                Todos los productos nuevos vendidos por BEYONIX cuentan con una garantía de
                {` ${DEFAULT_PRODUCT_WARRANTY_MONTHS} meses`} desde su entrega. Ese plazo es el máximo
                de garantía ofrecido por BEYONIX para sus productos.
              </p>
              <p>
                La garantía alcanza defectos o vicios que afecten la identidad entre lo ofrecido y lo
                entregado o su correcto funcionamiento. No cubre daños causados exclusivamente por
                golpes posteriores, líquidos, conexión eléctrica inadecuada, uso contrario a las
                instrucciones, desgaste normal, desarme, modificación o reparación no autorizada,
                siempre que tales circunstancias sean comprobables y guarden relación con la falla.
              </p>
              <LegalList>
                <LegalListItem>BEYONIX gestiona la garantía frente al cliente durante el plazo indicado.</LegalListItem>
                <LegalListItem>Cuando el producto deba trasladarse para cumplir la garantía legal, el transporte y los seguros correspondientes son a cargo de los responsables de la garantía.</LegalListItem>
              </LegalList>
            </LegalSection>

            <LegalSection
              id="privacidad"
              number="12"
              eyebrow="Datos personales"
              title="Privacidad, tratamiento y seguridad"
              icon={LockKeyhole}
            >
              <p>
                BEYONIX trata los datos necesarios para registrar cuentas, procesar compras, validar
                pagos, emitir comprobantes, entregar pedidos, brindar soporte, administrar garantías,
                prevenir fraude y cumplir obligaciones legales. Esto puede incluir nombre, email,
                teléfono, DNI, domicilio, historial de pedidos, comprobantes, conversaciones,
                evidencia de reclamos y datos bancarios aportados exclusivamente para reintegros.
              </p>
              <LegalList>
                <LegalListItem>Los pagos con tarjeta se procesan mediante Mercado Pago; BEYONIX no conserva los datos completos de la tarjeta.</LegalListItem>
                <LegalListItem>Los datos indispensables pueden comunicarse a proveedores de infraestructura, autenticación, almacenamiento, email, logística, pagos y facturación —incluidos Andreani, Mercado Pago y ARCA— para cumplir la operación.</LegalListItem>
                <LegalListItem>El sitio utiliza cookies y almacenamiento local o de sesión para autenticación, carrito, seguridad, preferencias y funcionamiento; en producción utiliza analítica para medir el desempeño del sitio.</LegalListItem>
                <LegalListItem>La información se conserva durante los plazos operativos, contractuales, fiscales y legales aplicables, y se protege mediante controles de acceso y permisos por rol.</LegalListItem>
              </LegalList>
              <p>
                El titular puede solicitar acceso a sus datos y, cuando corresponda, su rectificación,
                actualización, confidencialidad o supresión escribiendo a {BEYONIX_EMAIL}. El acceso debe
                atenderse dentro de los 10 días corridos; la rectificación, actualización o supresión,
                dentro de los 5 días hábiles, salvo obligaciones legales de conservación.
              </p>
              <Link href="/privacidad" className="inline-flex font-semibold text-beyonix-sky underline-offset-4 hover:text-white hover:underline">
                Consultar la Política de Privacidad completa
              </Link>
            </LegalSection>

            <LegalSection
              id="propiedad"
              number="13"
              eyebrow="Activos de la marca"
              title="Propiedad intelectual y uso del sitio"
              icon={Copyright}
            >
              <p>
                La marca BEYONIX, su identidad visual, logotipos, diseño de interfaz, textos,
                fotografías propias, piezas gráficas, catálogos y código se encuentran protegidos
                por las normas aplicables. Las marcas y materiales de terceros pertenecen a sus
                respectivos titulares y se utilizan con fines identificatorios o comerciales lícitos.
              </p>
              <p>
                No se autoriza copiar, revender, publicar, modificar, extraer de forma automatizada,
                suplantar ni explotar comercialmente estos contenidos sin permiso previo. El acceso
                al sitio no transfiere licencias ni derechos de propiedad intelectual.
              </p>
              <p>
                BEYONIX se reserva el derecho de proteger su marca, corregir errores, actualizar el
                catálogo y adoptar medidas razonables contra usos fraudulentos o técnicamente
                perjudiciales, sin afectar compras confirmadas ni derechos del consumidor.
              </p>
            </LegalSection>

            <LegalSection
              id="vigencia"
              number="14"
              eyebrow="Cierre legal"
              title="Vigencia, cambios y normativa aplicable"
              icon={Scale}
            >
              <p>
                Estos términos rigen desde la fecha de actualización indicada. Las modificaciones
                futuras se publicarán en esta página y no alterarán retroactivamente las condiciones
                de una compra ya confirmada, salvo que resulten más favorables o sean exigidas por ley.
              </p>
              <p>
                Se aplica la legislación de la República Argentina, especialmente la Ley 24.240 de
                Defensa del Consumidor, el Código Civil y Comercial de la Nación, la Ley 25.326 de
                Protección de los Datos Personales y la normativa vigente sobre comercio electrónico.
                El consumidor puede recurrir a las autoridades y vías de resolución competentes sin
                renunciar a la jurisdicción que legalmente le corresponda.
              </p>
              <p>
                BEYONIX comercializa sus productos para consumidores finales. No se aceptan compras
                destinadas a reventa, integración en procesos comerciales de terceros o uso empresarial
                salvo autorización expresa.
              </p>
              <div className="grid gap-2.5 sm:grid-cols-3">
                <a href="https://www.argentina.gob.ar/normativa/nacional/638/actualizacion" target="_blank" rel="noopener noreferrer" className="rounded-xl border border-white/8 bg-black/20 p-3 text-xs font-semibold leading-5 text-white/62 transition hover:border-beyonix-blue-light/38 hover:text-white"><FileText className="mb-2 size-4 text-beyonix-cyan" />Ley 24.240<br />Defensa del Consumidor</a>
                <a href="https://www.argentina.gob.ar/normativa/nacional/disposici%C3%B3n-954-2025-417152/texto" target="_blank" rel="noopener noreferrer" className="rounded-xl border border-white/8 bg-black/20 p-3 text-xs font-semibold leading-5 text-white/62 transition hover:border-beyonix-blue-light/38 hover:text-white"><RefreshCcw className="mb-2 size-4 text-beyonix-cyan" />Disposición 954/2025<br />Arrepentimiento</a>
                <a href="https://www.argentina.gob.ar/normativa/nacional/64790/actualizacion" target="_blank" rel="noopener noreferrer" className="rounded-xl border border-white/8 bg-black/20 p-3 text-xs font-semibold leading-5 text-white/62 transition hover:border-beyonix-blue-light/38 hover:text-white"><LockKeyhole className="mb-2 size-4 text-beyonix-cyan" />Ley 25.326<br />Datos personales</a>
              </div>
            </LegalSection>

            <section className="rounded-2xl border border-beyonix-blue-light/26 bg-[radial-gradient(circle_at_10%_0%,rgba(44,108,163,0.22),transparent_38%),linear-gradient(145deg,rgba(17,42,67,0.42),rgba(5,9,14,0.98))] p-6 sm:p-7">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="max-w-2xl">
                  <p className="text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">Ayuda y gestión</p>
                  <h2 className="mt-2 text-2xl font-bold text-white">¿Necesitás consultar una condición?</h2>
                  <p className="mt-2 text-sm leading-6 text-white/60">Escribinos indicando tu número de pedido y el email utilizado en la compra. Nunca incluyas contraseñas ni datos completos de tarjetas.</p>
                </div>
                <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                  <BeyonixButton asChild>
                    <a href={`mailto:${BEYONIX_EMAIL}`}><Mail className="size-4" />Contactar a BEYONIX</a>
                  </BeyonixButton>
                  <BeyonixButton asChild variant="secondary">
                    <Link href="/devoluciones"><PackageCheck className="size-4" />Cambios y devoluciones</Link>
                  </BeyonixButton>
                </div>
              </div>
            </section>
          </div>
        </div>
      </section>
    </main>
  )
}
