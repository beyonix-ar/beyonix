import type { Metadata } from "next"

import { AdminAccionesMasivas } from "@/app/admin/sections/acciones-masivas/admin-acciones-masivas"

export const metadata: Metadata = { title: "Editor masivo" }

export default function AdminBulkEditorPage() {
  return <AdminAccionesMasivas />
}
