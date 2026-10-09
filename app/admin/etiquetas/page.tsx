import type { Metadata } from "next"

import { AdminEtiquetas } from "@/app/admin/sections/etiquetas/admin-etiquetas"

export const metadata: Metadata = { title: "Etiquetas" }

export default function AdminLabelsPage() {
  return <AdminEtiquetas />
}
