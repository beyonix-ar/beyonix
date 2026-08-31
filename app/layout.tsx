import type { Metadata, Viewport } from "next"
import Script from "next/script"
import { Montserrat } from "next/font/google"
import { Analytics } from "@vercel/analytics/next"
import { CartProvider } from "@/context/cart-context"
import { AuthProvider } from "@/context/auth-context"
import { CustomerCreditProvider } from "@/context/customer-credit-context"
import { BrowserTabTitle } from "@/components/BrowserTabTitle"
import { BeyonixShootingStarsBackground } from "@/components/backgrounds/beyonix-shooting-stars-background"
import { LayoutShell } from "@/components/layout-shell"
import { CartWrapper } from "@/components/cart/cart-wrapper"
import "./globals.css"

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
  variable: "--font-montserrat",
})

export const metadata: Metadata = {
  title: "BEYONIX | Tecnología para tu comodidad",
  description:
    "Descubrí la mejor tecnología para tu hogar y estilo de vida. Productos premium de audio, iluminación LED, accesorios para celulares, hogar inteligente y más. Envíos a toda Argentina.",
  keywords:
    "tecnología, hogar inteligente, auriculares, LED, accesorios celular, mate térmico, Argentina",
  icons: {
    icon: [
      {
        url: "/icon.png?v=2",
        type: "image/png",
        sizes: "512x512",
      },
    ],
    shortcut: "/icon.png?v=2",
    apple: [
      {
        url: "/apple-icon.png?v=2",
        type: "image/png",
        sizes: "180x180",
      },
    ],
  },
  openGraph: {
    title: "BEYONIX | Tecnología para tu comodidad",
    description: "Productos premium de tecnología y confort para tu vida diaria",
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
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="es"
      data-scroll-behavior="smooth"
      className={montserrat.variable}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <Script id="beyonix-scroll-restoration" strategy="beforeInteractive">
          {`if ("scrollRestoration" in history) history.scrollRestoration = "manual";`}
        </Script>
        {/*
          Resuelve el tema del Admin ANTES del primer paint para evitar el
          flash oscuro->claro (o viceversa) al cargar. Sólo lee/escribe un
          atributo en <html>; las reglas CSS que reaccionan a él están
          scopeadas bajo .beyonix-admin-shell (ver globals.css), así que no
          afecta a la tienda pública aunque el atributo exista en cualquier
          página. suppressHydrationWarning en <html> es necesario porque
          este script corre fuera del árbol de React, antes de la
          hidratación.
        */}
        <Script id="beyonix-admin-theme-init" strategy="beforeInteractive">
          {`try {
            var t = window.localStorage.getItem("beyonix-admin-theme");
            document.documentElement.setAttribute(
              "data-admin-theme",
              t === "light" || t === "dark" ? t : "dark"
            );
          } catch (e) {
            document.documentElement.setAttribute("data-admin-theme", "dark");
          }`}
        </Script>
        <BrowserTabTitle />
        <BeyonixShootingStarsBackground />
        <div className="relative z-10">
          <AuthProvider>
            <CustomerCreditProvider>
              <CartProvider>
                <LayoutShell>{children}</LayoutShell>
                <CartWrapper />
              </CartProvider>
            </CustomerCreditProvider>
          </AuthProvider>
        </div>
        {process.env.NODE_ENV === "production" && <Analytics />}
      </body>
    </html>
  )
}
