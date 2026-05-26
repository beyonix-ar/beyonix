import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { createServerClient } from '@supabase/ssr'

export async function middleware(
  request: NextRequest
) {
  const response = NextResponse.next()

  const supabase =
    createServerClient(
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
      }
    )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const isAdminRoute =
    request.nextUrl.pathname.startsWith(
      '/admin'
    )

  if (isAdminRoute) {
    if (!user) {
      return NextResponse.redirect(
        new URL('/login', request.url)
      )
    }

    const { data: profile } =
      await supabase
        .from('profiles')
        .select('rol')
        .eq('id', user.id)
        .single()

    if (
      !profile ||
      profile.rol !== 'admin'
    ) {
      return NextResponse.redirect(
        new URL('/', request.url)
      )
    }
  }

  return response
}

export const config = {
  matcher: ['/admin/:path*'],
}