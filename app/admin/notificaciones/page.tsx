import type { Metadata } from "next"

import { AdminNotificaciones } from "@/app/admin/sections/notificaciones/admin-notificaciones"

export const metadata: Metadata = { title: "Notificaciones" }

export default function AdminNotificationsPage() {
  return <AdminNotificaciones />
}
