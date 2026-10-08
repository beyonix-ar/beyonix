import type { CookieMethodsServer } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

/** Propaga el refresh tanto al render actual como al navegador. */
export function createProxyCookieAdapter(
  request: NextRequest,
  requestHeaders: Headers,
  createResponse: () => NextResponse,
) {
  let response = createResponse()

  const cookies: CookieMethodsServer = {
    getAll() {
      return request.cookies.getAll()
    },
    setAll(cookiesToSet, headersToSet) {
      const previousCookies = response.cookies.getAll()
      for (const { name, value, options } of cookiesToSet) {
        if (options.maxAge === 0 || !value) request.cookies.delete(name)
        else request.cookies.set(name, value)
      }
      requestHeaders.set("cookie", request.headers.get("cookie") ?? "")

      response = createResponse()
      for (const cookie of previousCookies) response.cookies.set(cookie)
      for (const { name, value, options } of cookiesToSet) {
        response.cookies.set(name, value, options)
      }
      for (const [name, value] of Object.entries(headersToSet)) {
        response.headers.set(name, value)
      }
    },
  }

  function redirect(url: URL) {
    const redirected = NextResponse.redirect(url)
    for (const cookie of response.cookies.getAll()) redirected.cookies.set(cookie)
    for (const name of ["Cache-Control", "Expires", "Pragma"]) {
      const value = response.headers.get(name)
      if (value) redirected.headers.set(name, value)
    }
    return redirected
  }

  return { cookies, getResponse: () => response, redirect }
}
