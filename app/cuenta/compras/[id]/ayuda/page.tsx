import type { Metadata } from "next"
import { Suspense } from "react"

import { CompraAyudaClient } from "@/app/cuenta/cuenta-client"

export const metadata: Metadata = {
  title: "Ayuda con tu compra | BEYONIX",
  description: "Consultá o iniciá un reclamo relacionado con tu compra.",
}

export default async function CompraAyudaPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const orderId = Number(id)

  return (
    <Suspense fallback={null}>
      <CompraAyudaClient orderId={Number.isFinite(orderId) ? orderId : 0} />
    </Suspense>
  )
}
