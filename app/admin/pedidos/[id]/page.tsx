import { Suspense } from "react"

import { AdminClient } from "@/app/admin/admin-client"

export default async function AdminOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const orderId = Number(id)

  return (
    <Suspense fallback={null}>
      <AdminClient initialOrderId={Number.isFinite(orderId) ? orderId : undefined} />
    </Suspense>
  )
}
