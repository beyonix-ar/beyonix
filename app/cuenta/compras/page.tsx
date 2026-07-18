import { redirect } from "next/navigation"

export default function ComprasPage() {
  redirect("/cuenta?tab=ordenes")
}
