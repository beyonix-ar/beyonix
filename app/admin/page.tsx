import { redirect } from "next/navigation"

import {
  getLegacyAdminRedirectTarget,
  type LegacyAdminSearchParams,
} from "@/lib/admin/admin-routes"

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<LegacyAdminSearchParams>
}) {
  const params = await searchParams
  redirect(getLegacyAdminRedirectTarget(params))
}
