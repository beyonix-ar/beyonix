import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

import {
  ADMIN_ROUTES,
  canAccessAdminRoute,
  getAdminRouteKeyFromPathname,
} from "@/lib/admin/admin-routes"
import { isInternalRole, isUserRole } from "@/lib/auth/roles"

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

  if (
    !profile ||
    !isUserRole(profile.rol) ||
    !isInternalRole(profile.rol)
  ) {
    return NextResponse.redirect(new URL("/", request.url))
  }

  const routeKey = getAdminRouteKeyFromPathname(pathname)
  if (!canAccessAdminRoute(profile.rol, routeKey)) {
    return NextResponse.redirect(
      new URL(ADMIN_ROUTES.dashboard, request.url),
    )
  }

  return response
}

export const config = {
  matcher: ["/admin/:path*", "/cuenta/:path*"],
}
