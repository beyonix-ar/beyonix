import type { Metadata } from "next"
import { EliminarCuentaClient } from "./eliminar-cuenta-client"

export const metadata: Metadata = {
  title: "Eliminar cuenta | BEYONIX",
  description:
    "Confirmación para eliminar permanentemente una cuenta BEYONIX.",
}

export default function EliminarCuentaPage() {
  return <EliminarCuentaClient />
}
