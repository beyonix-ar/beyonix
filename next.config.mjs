/** @type {import('next').NextConfig} */
const nextConfig = {
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
  },
}

export default nextConfig
