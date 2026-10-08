import type { Metadata } from "next"
import { Suspense } from "react"

import { AdminLogistica } from "@/app/admin/sections/logistica/admin-logistica"

export const metadata: Metadata = { title: "Logística" }

export default function AdminLogisticsPage() {
  return (
    <Suspense>
      <AdminLogistica />
    </Suspense>
  )
}
