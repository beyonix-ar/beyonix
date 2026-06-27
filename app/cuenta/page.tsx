import type { Metadata } from "next"
import { Suspense } from "react"
import { CuentaClient } from "./cuenta-client"

export const metadata: Metadata = {
  title: "Mi cuenta | BEYONIX",
  description: "Accedé a tu cuenta BEYONIX para ver tus órdenes y datos.",
}

export default function CuentaPage() {
  return (
    <Suspense fallback={null}>
      <CuentaClient />
    </Suspense>
  )
}
