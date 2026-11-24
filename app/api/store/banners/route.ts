import { createClient } from "@/lib/supabase/server"
import { publicBannersResponse } from "@/lib/banners/public-banners-response"

export async function GET(request: Request) {
  return publicBannersResponse(request, () => createClient())
}
