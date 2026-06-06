import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get("code")
  const type = requestUrl.searchParams.get("type")
  const isRecovery = type === "recovery"
  const redirectUrl = new URL(
    isRecovery ? "/reset-password" : "/login",
    request.url
  )

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

  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    const failedRedirect = new URL("/login", request.url)
    failedRedirect.searchParams.set("auth-error", "confirmation")
    const failedResponse = NextResponse.redirect(failedRedirect)

    for (const cookie of request.cookies.getAll()) {
      if (cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token")) {
        failedResponse.cookies.set(cookie.name, "", {
          path: "/",
          maxAge: 0,
        })
      }
    }

    return failedResponse
  }

  return response
}
