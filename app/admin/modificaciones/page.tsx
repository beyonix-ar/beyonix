import type { Metadata } from "next"

import { AdminModificaciones } from "@/app/admin/sections/modificaciones/admin-modificaciones"

export const metadata: Metadata = { title: "Configuración" }

export default function AdminModificationsPage() {
  return <AdminModificaciones />
}
