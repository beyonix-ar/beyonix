import type { Metadata } from "next"

import { AdminDispatches } from "@/app/admin/sections/despachos/admin-dispatches"

export const metadata: Metadata = { title: "Despachos" }

export default async function DispatchesPage({ searchParams }: { searchParams: Promise<{ tab?: string; batch?: string; order?: string; resolve?: string }> }) {
  const params = await searchParams
  return <AdminDispatches initialTab={params.tab} initialBatchId={params.batch} initialOrderId={params.order} initialResolveId={params.resolve} />
}
