import type { Metadata } from "next"
import { Suspense } from "react"

import { CompraDetalleClient } from "@/app/cuenta/cuenta-client"

export const metadata: Metadata = {
  title: "Detalle de compra | BEYONIX",
  description: "Consultá el estado y el detalle de tu compra en BEYONIX.",
}

export default async function CompraDetallePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const orderId = Number(id)

  return (
    <Suspense fallback={null}>
      <CompraDetalleClient orderId={Number.isFinite(orderId) ? orderId : 0} />
    </Suspense>
  )
}
