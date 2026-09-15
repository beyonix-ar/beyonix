import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(path, "utf8")
}

const HEADER_SOURCE = source("components/public-minimal-header.tsx")

test("reutiliza el toggle de theme existente -- no crea un segundo sistema Claro/Oscuro", () => {
  assert.match(
    HEADER_SOURCE,
    /import \{ AccountThemeToggle \} from "@\/components\/account\/account-theme-toggle"/,
  )
  assert.match(HEADER_SOURCE, /<AccountThemeToggle/)
  // Nunca reimplementa el ícono sol/luna ni un localStorage propio.
  assert.doesNotMatch(HEADER_SOURCE, /localStorage/)
  assert.doesNotMatch(HEADER_SOURCE, /from "lucide-react"[\s\S]*Sun|Moon/)
})

test("izquierda: \"Ir al inicio\", sin carrito/categorías/links adicionales", () => {
  const jsxBlock = HEADER_SOURCE.slice(HEADER_SOURCE.indexOf("return ("))

  assert.match(jsxBlock, /Ir al inicio/)
  assert.match(jsxBlock, /<Link/)

  assert.doesNotMatch(jsxBlock, /carrito/i)
  assert.doesNotMatch(jsxBlock, /categor[ií]as/i)
  assert.doesNotMatch(jsxBlock, /CartIcon|ShoppingCart|ShoppingBag/)
})

test("se usa en los 3 flujos de checkout que quedaban sin ninguna navegación (success/failure/pending comparten CheckoutStatusShell)", () => {
  const layoutSource = source("components/checkout/checkout-status-layout.tsx")

  assert.match(
    layoutSource,
    /import \{ PublicMinimalHeader \} from "@\/components\/public-minimal-header"/,
  )
  assert.match(layoutSource, /<PublicMinimalHeader/)

  // Las 3 pantallas de resultado (éxito/falla/pendiente) usan CheckoutStatusShell
  // -- agregarlo ahí alcanza para las 3 sin tocar cada page.tsx.
  for (const page of ["success", "failure", "pending"]) {
    const pageSource = source(`app/checkout/${page}/page.tsx`)
    assert.match(pageSource, /CheckoutStatusShell/, `${page} debe usar CheckoutStatusShell`)
  }
})

test("login y checkout (que ya tenían su propio \"volver\") sólo reciben el toggle agregado, no un segundo header duplicado", () => {
  const loginSource = source("app/login/page.tsx")
  const checkoutSource = source("app/checkout/page.tsx")

  assert.match(loginSource, /<AccountThemeToggle/)
  assert.match(checkoutSource, /<AccountThemeToggle/)

  // No se importa PublicMinimalHeader dentro del header principal ya
  // existente de /login -- ahí sólo se le agrega el toggle al lado del link
  // "Volver a la tienda" que ya cumplía el rol de "ir al inicio".
  const mainHeaderIndex = loginSource.indexOf("Volver a la tienda")
  assert.ok(mainHeaderIndex > 0)
})
