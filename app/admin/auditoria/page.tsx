import type { Metadata } from "next"

import { AdminAuditoria } from "@/app/admin/sections/auditoria/admin-auditoria"

export const metadata: Metadata = { title: "Auditoría" }

export default function AdminAuditPage() {
  return <AdminAuditoria />
}
