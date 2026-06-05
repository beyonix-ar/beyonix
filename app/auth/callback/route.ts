import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get("code")
  const type = requestUrl.searchParams.get("type")
  const isRecovery = !type || type === "recovery"
  const next =
    requestUrl.searchParams.get("next") ||
    (isRecovery ? "/reset-password" : "/login?confirmed=1")
  const redirectUrl = new URL(next, request.url)

  if (
    code &&
    redirectUrl.pathname.startsWith("/reset-password") &&
    isRecovery
  ) {
    redirectUrl.searchParams.set("recovery", "1")
  }

  const response = NextResponse.redirect(redirectUrl)

  if (!code) {
    return response
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  await supabase.auth.exchangeCodeForSession(code)

  return response
}
