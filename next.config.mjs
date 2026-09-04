// Headers de seguridad que no requieren conocer de antemano cada host externo
// que carga la app (a diferencia de una Content-Security-Policy real, que
// necesitaría allowlistear con precisión Supabase, los tiles de mapa de
// Andreani/Leaflet, Vercel Analytics, etc. -- una CSP mal armada rompe la app
// en silencio en vez de fallar ruidosamente, así que no se agrega a ciegas
// acá). Verificado antes de agregar: no hay SDK de Mercado Pago cargado en el
// cliente (Checkout Pro es un redirect, no un iframe embebido) y no se usa
// `navigator.geolocation` en ningún lado, así que Permissions-Policy puede
// deshabilitar esas features sin romper nada existente.
//
// PENDIENTE (documentado, no implementado):
//   - Content-Security-Policy: requiere enumerar con precisión cada origen
//     externo real (Supabase, tiles de mapa, fuentes, analytics) y probarlo
//     visualmente contra cada página antes de habilitarla.
//   - Strict-Transport-Security: el dominio está en medio de una migración
//     de hosting pendiente (Netlify -> DonWeb, fuera de alcance de esta
//     tarea); HSTS se cachea en el navegador del visitante durante todo su
//     max-age y es difícil de revertir si HTTPS se interrumpe brevemente
//     durante ese cambio de infraestructura -- se agrega recién cuando el
//     hosting final esté estable.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(self)",
  },
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
