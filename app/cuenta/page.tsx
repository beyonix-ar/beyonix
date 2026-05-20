import type { Metadata } from "next"
import { CuentaClient } from "./cuenta-client"

export const metadata: Metadata = {
  title: "Mi cuenta | BEYONIX",
  description: "Accedé a tu cuenta BEYONIX para ver tus pedidos y datos.",
}

export default function CuentaPage() {
  return <CuentaClient />
}