import type { Metadata } from "next"

import { AdminEventos } from "@/app/admin/sections/eventos/admin-eventos"

export const metadata: Metadata = { title: "Eventos" }

export default function AdminEventsPage() {
  return <AdminEventos />
}
