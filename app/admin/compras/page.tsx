import type { Metadata } from "next"

import { AdminCostsPanel } from "@/app/admin/sections/dashboard/admin-costs-panel"

export const metadata: Metadata = { title: "Compras" }

export default function AdminPurchasesPage() {
  return (
    <div className="min-w-0 space-y-6 p-4 sm:p-6 lg:p-8">
      <AdminCostsPanel />
    </div>
  )
}
