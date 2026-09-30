import type { Metadata } from "next"

import { AdminResenas } from "@/app/admin/sections/resenas/admin-resenas"

export const metadata: Metadata = { title: "Reseñas" }

export default function AdminReviewsPage() {
  return <AdminResenas />
}
