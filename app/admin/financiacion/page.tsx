import type { Metadata } from "next"

import { AdminFinanciacion } from "@/app/admin/sections/financiacion/admin-financiacion"

export const metadata: Metadata = { title: "Financiación" }

export default function AdminFinancingPage() {
  return <AdminFinanciacion />
}
