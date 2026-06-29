import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

export async function proxy(request: NextRequest) {
  const response = NextResponse.next()
  const pathname = request.nextUrl.pathname

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set() {},
        remove() {},
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isAdminRoute = pathname.startsWith("/admin")
  const isAccountRoute = pathname.startsWith("/cuenta")

  if (!isAdminRoute && !isAccountRoute) {
    return response
  }

  if (!user) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set(
      "redirect",
      `${pathname}${request.nextUrl.search}`
    )
    return NextResponse.redirect(loginUrl)
  }

  if (!isAdminRoute) {
    return response
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("rol")
    .eq("id", user.id)
    .single()

  return response
}

export const config = {
  matcher: ["/admin/:path*", "/cuenta/:path*"],
}
