import type { Metadata, Viewport } from "next"
import { Montserrat, Manrope } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { CartProvider } from "@/context/cart-context"
import { LayoutShell } from "@/components/layout-shell"
import { CartWrapper } from "@/components/cart/cart-wrapper"
import "./globals.css"

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-heading",
})

const manrope = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
})

export const metadata: Metadata = {
  title: "BEYONIX | Tecnología para tu comodidad",
  description:
    "Descubrí la mejor tecnología para tu hogar y estilo de vida. Productos premium de audio, iluminación LED, accesorios para celulares, hogar inteligente y más. Envíos a toda Argentina.",
  keywords:
    "tecnología, hogar inteligente, auriculares, LED, accesorios celular, mate térmico, Argentina",
  openGraph: {
    title: "BEYONIX | Tecnología para tu comodidad",
    description:
      "Productos premium de tecnología y confort para tu vida diaria",
    type: "website",
    locale: "es_AR",
  },
}

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="es">
      <body
        className={`${montserrat.variable} ${manrope.variable} antialiased`}
      >
        <CartProvider>
          <LayoutShell>
            {children}
          </LayoutShell>

          <CartWrapper />
        </CartProvider>

        {process.env.NODE_ENV === "production" && <Analytics />}
      </body>
    </html>
  )
}