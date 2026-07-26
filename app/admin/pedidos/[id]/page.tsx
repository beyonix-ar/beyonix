import type { Metadata } from "next"

import { AdminPedidos } from "@/app/admin/sections/pedidos/admin-pedidos"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  return { title: `Pedido ${id}` }
}

export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const orderId = Number(id)

  return <AdminPedidos initialOrderId={Number.isFinite(orderId) ? orderId : undefined} />
}
