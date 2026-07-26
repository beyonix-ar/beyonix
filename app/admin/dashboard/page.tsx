import type { Metadata } from "next"

import { AdminDashboard } from "@/app/admin/sections/dashboard/admin-dashboard"

export const metadata: Metadata = { title: "Dashboard" }

export default function AdminDashboardPage() {
  return <AdminDashboard />
}
