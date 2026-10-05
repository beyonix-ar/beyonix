import type { Metadata } from "next"

import { AdminDispatches } from "@/app/admin/sections/despachos/admin-dispatches"

export const metadata: Metadata = { title: "Despachos" }

export default async function DispatchesPage({ searchParams }: { searchParams: Promise<{ batch?: string; order?: string }> }) {
  const params = await searchParams
  return <AdminDispatches initialBatchId={params.batch} initialOrderId={params.order} />
}
