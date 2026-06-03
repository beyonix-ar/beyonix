import { Suspense } from "react"

import { AdminClient } from "./admin-client"

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <AdminClient />
    </Suspense>
  )
}
