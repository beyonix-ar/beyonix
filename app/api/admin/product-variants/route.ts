import { requireInternalUser } from "@/lib/auth/admin-api"

export async function GET(request: Request) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const { data: variants, error } = await auth.admin
    .from("producto_variantes")
    .select("*")
    .order("orden", { ascending: true })
    .order("id", { ascending: true })

  if (error) {
    return Response.json(
      { error: error.message || "No se pudieron cargar las variantes." },
      { status: 500 },
    )
  }

  return Response.json({ variants: variants ?? [] })
}
