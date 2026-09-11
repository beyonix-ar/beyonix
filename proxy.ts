import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

import {
  ADMIN_ROUTES,
  canAccessAdminRoute,
  getAdminRouteKeyFromPathname,
} from "@/lib/admin/admin-routes"
import { isInternalRole, isUserRole } from "@/lib/auth/roles"
import { resolveCspMode } from "@/lib/security/csp-mode"

const IS_DEV = process.env.NODE_ENV !== "production"

const SUPABASE_HOST = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host || null
  } catch {
    return null
  }
})()

/** Nonce criptográfico por request (Web Crypto, disponible en el Edge Runtime). */
function generateNonce() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Construye la Content-Security-Policy. El modo (Report-Only vs enforcing)
 * lo decide `resolveCspMode`/CSP_MODE, no esta función -- acá sólo viven las
 * directivas. Ver informe de la tarea para el detalle de cada origen
 * permitido y las concesiones deliberadas (media-src, style-src).
 */
function buildContentSecurityPolicy(nonce: string) {
  const supabaseHttp = SUPABASE_HOST ? `https://${SUPABASE_HOST}` : null
  const supabaseWs = SUPABASE_HOST ? `wss://${SUPABASE_HOST}` : null

  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'self'"]],
    [
      "script-src",
      [
        "'self'",
        `'nonce-${nonce}'`,
        "'strict-dynamic'",
        // Turbopack/webpack dev usan eval() para HMR; nunca en producción.
        ...(IS_DEV ? ["'unsafe-eval'"] : []),
      ],
    ],
    // Sin nonce acá a propósito: la UI usa extensivamente el atributo
    // style="" de React (no sólo <style> tags), y un nonce en style-src
    // invalida 'unsafe-inline' para navegadores que soportan nonce -- eso
    // bloquearía todos los style="" inline. Ver informe de la tarea.
    ["style-src", ["'self'", "'unsafe-inline'"]],
    [
      "img-src",
      [
        "'self'",
        "data:",
        "blob:",
        "https://*.tile.openstreetmap.org",
        ...(supabaseHttp ? [supabaseHttp] : []),
      ],
    ],
    ["font-src", ["'self'"]],
    // Concesión deliberada (requisito de la tarea): el video "directo" de
    // producto acepta cualquier URL https cargada por el admin (ver
    // lib/products/product-video.ts), no sólo Supabase Storage. Restringir
    // a un host fijo rompería video ya cargado por contenido existente.
    ["media-src", ["'self'", "https:"]],
    [
      "connect-src",
      [
        "'self'",
        ...(supabaseHttp ? [supabaseHttp] : []),
        ...(supabaseWs ? [supabaseWs] : []),
        ...(IS_DEV ? ["ws://localhost:*", "ws://127.0.0.1:*"] : []),
      ],
    ],
    [
      "frame-src",
      [
        "'self'",
        "blob:",
        "https://www.youtube-nocookie.com",
        "https://player.vimeo.com",
      ],
    ],
    ["report-uri", ["/api/csp-report"]],
    ...(IS_DEV ? [] : ([["upgrade-insecure-requests", []]] as [string, string[]][])),
  ]

  return directives
    .map(([key, values]) => (values.length > 0 ? `${key} ${values.join(" ")}` : key))
    .join("; ")
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const nonce = generateNonce()
  const csp = buildContentSecurityPolicy(nonce)
  // CSP_MODE=enforce (exacto) envía Content-Security-Policy; cualquier otro
  // valor -- ausente, vacío, typo -- cae en report-only por fail-safe (ver
  // lib/security/csp-mode.ts). Nunca se envían las dos cabeceras a la vez:
  // es un único `set` condicionado al modo resuelto acá.
  const cspHeaderName =
    resolveCspMode(process.env.CSP_MODE) === "enforce"
      ? "Content-Security-Policy"
      : "Content-Security-Policy-Report-Only"

  // El nonce y la CSP se propagan también en los request headers (no sólo
  // en la respuesta) porque el App Router de Next.js lee el nonce desde ahí
  // para inyectarlo automáticamente en sus propios scripts inline
  // (ver node_modules/next/dist/server/app-render/get-script-nonce-from-header.js,
  // que busca 'content-security-policy' o 'content-security-policy-report-only').
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set(cspHeaderName.toLowerCase(), csp)

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  })
  response.headers.set(cspHeaderName, csp)

  const isAdminRoute = pathname.startsWith("/admin")
  const isAccountRoute = pathname.startsWith("/cuenta")

  // auth.getUser() sólo se ejecuta para /admin y /cuenta -- el resto del
  // sitio público no debe pagar ese round-trip a Supabase Auth sólo porque
  // el proxy ahora corre globalmente para poder emitir CSP/nonce.
  if (!isAdminRoute && !isAccountRoute) {
    return response
  }

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
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
