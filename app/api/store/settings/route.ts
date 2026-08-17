import { getSiteSettings } from "@/lib/site-settings"

export async function GET() {
  const settings = await getSiteSettings()

  return Response.json({ settings }, {
    // La deduplicación vive en el cliente durante 15 s. Evitamos una segunda
    // capa HTTP con contenido stale porque podía sobrevivir a un PATCH
    // administrativo y mantener cálculos visibles obsoletos durante 120 s.
    headers: { "Cache-Control": "no-store" },
  })
}
