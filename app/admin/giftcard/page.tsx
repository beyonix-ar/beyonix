import type { Metadata } from "next"

import { AdminCreditos } from "@/app/admin/sections/creditos/admin-creditos"

export const metadata: Metadata = { title: "GiftCard" }

export default function AdminGiftCardPage() {
  return <AdminCreditos />
}
