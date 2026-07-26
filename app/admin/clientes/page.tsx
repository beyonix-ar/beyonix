import type { Metadata } from "next"

import { AdminClientes } from "@/app/admin/sections/clientes/admin-clientes"

export const metadata: Metadata = { title: "Clientes" }

export default function AdminCustomersPage() {
  return <AdminClientes />
}
