import type { Metadata } from "next"

import { AdminFacturacion } from "@/app/admin/sections/facturacion/admin-facturacion"

export const metadata: Metadata = { title: "Facturación" }

export default function AdminBillingPage() {
  return <AdminFacturacion />
}
