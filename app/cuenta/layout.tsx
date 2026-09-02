import type { ReactNode } from "react"

/**
 * El theme claro/oscuro del panel cliente se resuelve globalmente (ver
 * AccountThemeProvider en app/layout.tsx y context/account-theme-context.tsx)
 * mediante data-account-scope en <html>, no con un wrapper acá -- un <div>
 * anidado en este layout nunca sería ancestro de contenido "portaled" a
 * document.body (drawer del carrito, cualquier modal), así que no puede
 * ser el mecanismo de scope. Este layout queda como punto de extensión para
 * las rutas /cuenta/** si hace falta más adelante.
 */
export default function CuentaLayout({ children }: { children: ReactNode }) {
  return children
}
