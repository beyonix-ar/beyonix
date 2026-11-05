import type { Metadata, Viewport } from "next"

import { loadCourierDelivery } from "@/lib/orders/local-delivery-courier"
import { createAdminClient } from "@/lib/supabase/admin"

import { CourierDeliveryClient, CourierPageFrame } from "./courier-delivery-client"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Entrega BEYONIX",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" }

type Props = { params: Promise<{ token: string }> }

/**
 * Página del cadete: se abre al escanear el QR de la etiqueta Envío BEYONIX.
 * Sin login, menú ni navegación; sólo los datos mínimos del pedido y el
 * resultado de la entrega.
 */
export default async function CourierDeliveryPage({ params }: Props) {
  const { token } = await params
  let context: Awaited<ReturnType<typeof loadCourierDelivery>> = null
  let failed = false
  try {
    context = await loadCourierDelivery(createAdminClient(), token)
  } catch {
    failed = true
  }

  return (
    <CourierPageFrame>
      {context ? (
        <CourierDeliveryClient token={token} initialView={context.view} />
      ) : (
        <div className="mt-8 rounded-2xl border-2 border-neutral-300 bg-white p-5 text-center" role="alert">
          <p className="text-xl font-black">{failed ? "No pudimos cargar el pedido" : "Código QR no válido"}</p>
          <p className="mt-2 text-base text-neutral-700">
            {failed ? "Revisá la conexión y volvé a escanear el código." : "Este código no corresponde a una entrega activa. Consultá con BEYONIX."}
          </p>
        </div>
      )}
    </CourierPageFrame>
  )
}
