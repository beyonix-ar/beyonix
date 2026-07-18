import { getSiteSettings } from "@/lib/site-settings"

export async function GET() {
  const settings = await getSiteSettings()

  return Response.json({ settings })
}
