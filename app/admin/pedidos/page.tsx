import type { Metadata } from "next"

import { AdminPedidos } from "@/app/admin/sections/pedidos/admin-pedidos"

export const metadata: Metadata = { title: "Pedidos" }

export default function AdminOrdersPage() {
  return <AdminPedidos />
}
