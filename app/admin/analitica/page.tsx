import type { Metadata } from "next"

import { AdminAnalitica } from "@/app/admin/sections/analitica/admin-analitica"

export const metadata: Metadata = { title: "Analítica" }

export default function AdminAnalyticsPage() {
  return <AdminAnalitica />
}
