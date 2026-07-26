import type { Metadata } from "next"

import { AdminModificaciones } from "@/app/admin/sections/modificaciones/admin-modificaciones"

export const metadata: Metadata = { title: "Modificaciones" }

export default function AdminModificationsPage() {
  return <AdminModificaciones />
}
