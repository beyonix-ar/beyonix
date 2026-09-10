// Headers de seguridad estáticos (no dependen de un nonce por request).
// Content-Security-Policy sí depende de un nonce por request y vive en
// proxy.ts, no acá (ver ese archivo para el detalle de cada origen
// permitido). Verificado antes de agregar Permissions-Policy: no hay SDK de
// Mercado Pago cargado en el cliente (Checkout Pro es un redirect, no un
// iframe embebido) y no se usa `navigator.geolocation` en ningún lado, así
// que puede deshabilitar esas features sin romper nada existente.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(self)",
  },
  // max-age intencionalmente corto (5 min) y sin includeSubDomains/preload:
  // primera fase de HSTS mientras el dominio está en medio de una migración
  // de hosting pendiente (Netlify -> DonWeb, fuera de alcance de esta
  // tarea). Un max-age largo es difícil de revertir si HTTPS se interrumpe
  // brevemente durante ese cambio; éste expira solo en minutos. Sólo en
  // producción: no tiene efecto sobre http (`next dev`), pero se evita
  // igual para no confundir verificaciones locales de headers.
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=300" }]
    : []),
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ]
  },
  env: {
    NEXT_PUBLIC_FREE_SHIPPING_MIN_AMOUNT:
      process.env.NEXT_PUBLIC_FREE_SHIPPING_MIN_AMOUNT ||
      process.env.FREE_SHIPPING_MIN_AMOUNT ||
      "75000",
    NEXT_PUBLIC_FREE_SHIPPING_MODE:
      process.env.NEXT_PUBLIC_FREE_SHIPPING_MODE ||
      process.env.FREE_SHIPPING_MODE ||
      "full",
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname:
          "eqxoupwuijobktxkmagr.supabase.co",
      },
    ],
    formats: ["image/avif", "image/webp"],
  },
}

export default nextConfig
