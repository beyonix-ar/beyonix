import type { Metadata } from "next"
import Link from "next/link"
import {
  CheckCircle2,
  Clock3,
  Cookie,
  Database,
  Eye,
  KeyRound,
  LockKeyhole,
  ServerCog,
  Share2,
  ShieldCheck,
  UserRoundCheck,
} from "lucide-react"

import { BeyonixCard, BeyonixIconBox } from "@/components/beyonix-ui"
import { BEYONIX_EMAIL } from "@/lib/legal-contact"

export const metadata: Metadata = {
  title: "Política de privacidad | BEYONIX",
  description:
    "Información sobre el tratamiento, uso, conservación y protección de datos personales en BEYONIX.",
}

const LAST_UPDATED = "20 de julio de 2026"

const dataGroups = [
  {
    icon: UserRoundCheck,
    title: "Identificación y contacto",
    text: "Nombre, apellido, email, teléfono, DNI y datos necesarios para validar la cuenta o la operación.",
  },
  {
    icon: Database,
    title: "Compra y facturación",
    text: "Carrito, productos, variantes, importes, descuentos, pedidos, comprobantes y datos fiscales.",
  },
  {
    icon: Share2,
    title: "Entrega y posventa",
    text: "Domicilio, referencias, seguimiento, mensajes, reclamos, evidencia, devoluciones y garantías.",
  },
  {
    icon: KeyRound,
    title: "Uso y seguridad",
    text: "Sesión, preferencias, eventos técnicos, registros de acceso y señales necesarias para prevenir fraude.",
  },
]

function PrivacySection({
  icon: Icon,
  eyebrow,
  title,
  children,
}: {
  icon: typeof LockKeyhole
  eyebrow: string
  title: string
  children: React.ReactNode
}) {
  return (
    <BeyonixCard variant="information" className="p-5 sm:p-6 lg:p-7">
      <div className="flex items-start gap-3.5">
        <BeyonixIconBox size="lg"><Icon className="size-5" /></BeyonixIconBox>
        <div className="min-w-0 flex-1">
          <p className="text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan/80">{eyebrow}</p>
          <h2 className="mt-1.5 text-xl font-bold tracking-tight text-white sm:text-2xl">{title}</h2>
          <div className="mt-4 space-y-3 text-sm leading-7 text-white/66">{children}</div>
        </div>
      </div>
    </BeyonixCard>
  )
}

function PrivacyItem({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <CheckCircle2 className="mt-1.5 size-3.5 shrink-0 text-beyonix-cyan" />
      <span>{children}</span>
    </li>
  )
}

export default function PrivacidadPage() {
  return (
    <main className="min-h-screen bg-transparent text-white">
      <section className="relative overflow-hidden border-b border-beyonix-blue-light/14">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_8%,rgba(30,77,123,0.34),transparent_34%),radial-gradient(circle_at_84%_44%,rgba(24,91,128,0.15),transparent_31%),linear-gradient(180deg,rgba(3,8,14,0.66),rgba(0,0,0,0.9))]" />
        <div className="relative mx-auto max-w-6xl px-4 pb-12 pt-16 sm:px-6 sm:pb-14 sm:pt-20 lg:px-8 lg:pb-16 lg:pt-24">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-beyonix-blue-light/22 bg-beyonix-blue/16 px-3 py-1 text-10px font-semibold uppercase tracking-[0.18em] text-beyonix-cyan">Datos personales</span>
            <span className="rounded-full border border-white/8 bg-black/25 px-3 py-1 text-10px font-medium uppercase tracking-[0.14em] text-white/48">Actualizada el {LAST_UPDATED}</span>
          </div>
          <h1 className="mt-5 max-w-4xl text-4xl font-bold tracking-[-0.035em] text-white sm:text-5xl lg:text-6xl">Política de privacidad</h1>
          <p className="mt-5 max-w-3xl text-base leading-7 text-white/66 sm:text-lg sm:leading-8">
            Explicamos qué información utiliza BEYONIX, para qué la necesita, con quién puede
            compartirla y cómo protege los datos personales vinculados a la cuenta y las compras.
          </p>

          <div className="mt-9 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {dataGroups.map((group) => (
              <BeyonixCard key={group.title} variant="information" className="p-4">
                <BeyonixIconBox size="sm"><group.icon className="size-4" /></BeyonixIconBox>
                <h2 className="mt-3 text-sm font-bold text-white">{group.title}</h2>
                <p className="mt-1.5 text-xs leading-5 text-white/50">{group.text}</p>
              </BeyonixCard>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12 lg:px-8 lg:py-16">
        <div className="grid gap-4 lg:grid-cols-2">
          <PrivacySection icon={Eye} eyebrow="01 · Alcance" title="Responsable y origen de los datos">
            <p>
              BEYONIX, con base operativa en Rosario, Santa Fe, es responsable del tratamiento de
              los datos recopilados en su sitio y canales oficiales. La información proviene de lo
              que ingresás al crear una cuenta, comprar, pagar, solicitar un envío, comunicarte o
              gestionar un reclamo, y de registros técnicos generados al usar el servicio.
            </p>
            <p>
              Los datos obligatorios se identifican en cada formulario. Si no se proporcionan,
              puede resultar imposible crear la cuenta, emitir documentación, entregar el pedido o
              resolver la solicitud vinculada.
            </p>
          </PrivacySection>

          <PrivacySection icon={ServerCog} eyebrow="02 · Finalidades" title="Para qué se utiliza la información">
            <ul className="grid gap-2">
              <PrivacyItem>Autenticar la cuenta, mantener la sesión y recuperar el acceso.</PrivacyItem>
              <PrivacyItem>Procesar compras, validar pagos, reservar stock y emitir comprobantes.</PrivacyItem>
              <PrivacyItem>Preparar envíos, comunicar seguimiento y coordinar entregas.</PrivacyItem>
              <PrivacyItem>Atender mensajes, cancelaciones, reclamos, devoluciones y garantías.</PrivacyItem>
              <PrivacyItem>Asignar beneficios, saldo a favor y condiciones comerciales autorizadas.</PrivacyItem>
              <PrivacyItem>Prevenir fraude, proteger el sitio, auditar acciones y cumplir obligaciones legales.</PrivacyItem>
              <PrivacyItem>Medir rendimiento y mejorar la experiencia mediante información técnica y analítica.</PrivacyItem>
            </ul>
          </PrivacySection>

          <PrivacySection icon={Share2} eyebrow="03 · Proveedores" title="Destinatarios y servicios involucrados">
            <p>
              BEYONIX no vende bases de datos personales. Solo comunica la información necesaria a
              proveedores que intervienen en la operación o prestan infraestructura bajo sus propias
              condiciones de seguridad y confidencialidad.
            </p>
            <p>
              Esto puede incluir servicios de pago, envío, facturación, soporte técnico, hosting,
              email y analítica, siempre en la medida necesaria para brindar el servicio o cumplir
              obligaciones legales.
            </p>
          </PrivacySection>

          <PrivacySection icon={Cookie} eyebrow="04 · Navegación" title="Cookies y almacenamiento local">
            <p>
              El sitio utiliza cookies y almacenamiento local o de sesión indispensables para el
              inicio de sesión, el carrito, la seguridad, las preferencias y los beneficios asociados
              a la cuenta. Deshabilitarlos puede impedir funciones esenciales.
            </p>
            <p>
              En producción se emplea analítica para conocer visitas, rendimiento y errores de forma
              agregada. BEYONIX no utiliza estos mecanismos para almacenar datos completos de tarjetas
              ni contraseñas en texto visible.
            </p>
          </PrivacySection>

          <PrivacySection icon={Clock3} eyebrow="05 · Conservación" title="Durante cuánto tiempo se guardan">
            <p>
              Los datos se conservan mientras la cuenta o relación comercial permanezca activa y,
              luego, durante los plazos necesarios para facturación, garantías, prevención de fraude,
              auditoría, defensa de derechos y demás obligaciones legales.
            </p>
            <p>
              Cuando deja de existir una finalidad legítima u obligación de conservación, la
              información se elimina, anonimiza o restringe de manera razonable. Una solicitud de
              eliminación de cuenta no alcanza datos que deban conservarse por exigencias fiscales,
              contractuales u otras obligaciones legales.
            </p>
          </PrivacySection>

          <PrivacySection icon={ShieldCheck} eyebrow="06 · Protección" title="Seguridad y confidencialidad">
            <p>
              BEYONIX aplica controles de acceso, permisos por rol, autenticación, trazabilidad,
              validaciones del lado del servidor y almacenamiento restringido para reducir accesos
              no autorizados, alteraciones, pérdidas o divulgaciones indebidas.
            </p>
            <p>
              Ningún sistema es infalible. Si detectás actividad extraña, no compartas contraseñas ni
              códigos y escribí inmediatamente a {BEYONIX_EMAIL}. BEYONIX nunca solicita datos
              completos de tarjetas por email, chat o redes sociales.
            </p>
          </PrivacySection>

          <PrivacySection icon={LockKeyhole} eyebrow="07 · Vigencia" title="Cambios y marco aplicable">
            <p>
              Esta política se interpreta junto con los Términos y condiciones. Las actualizaciones
              se publicarán con su fecha de vigencia y no reducirán retroactivamente derechos
              reconocidos. El tratamiento se rige por la Ley 25.326 y demás normativa argentina aplicable.
            </p>
            <div className="flex flex-wrap gap-2">
              <a href="https://www.argentina.gob.ar/normativa/nacional/64790/actualizacion" target="_blank" rel="noopener noreferrer" className="font-semibold text-beyonix-sky underline-offset-4 hover:text-white hover:underline">Consultar Ley 25.326</a>
              <span className="text-white/24">·</span>
              <Link href="/terminos" className="font-semibold text-beyonix-sky underline-offset-4 hover:text-white hover:underline">Ver Términos y condiciones</Link>
            </div>
          </PrivacySection>
        </div>
      </section>
    </main>
  )
}
