import type { Metadata } from "next"

import { AdminProductos } from "@/app/admin/sections/productos/admin-productos"

export const metadata: Metadata = { title: "Productos" }

export default function AdminProductsPage() {
  return <AdminProductos />
}
