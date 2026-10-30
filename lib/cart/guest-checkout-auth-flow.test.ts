import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { buildLoginHref, getSafeRedirect } from "../auth/safe-redirect.ts"
import { CHECKOUT_PATH, getCheckoutEntryHref } from "./checkout-entry.ts"

// Invitado con carrito -> "Finalizar compra" -> /login (o registro) -> vuelve
// al checkout con el mismo carrito. La lógica del carrito está en
// guest-cart-handoff.test.ts; acá, la navegación y los contratos de las
// pantallas que la sostienen.

const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n")

const login = read("app/login/page.tsx")
const cartContext = read("context/cart-context.tsx")
const drawer = read("components/cart/cart-drawer.tsx")
const wrapper = read("components/cart/cart-wrapper.tsx")
const checkout = read("app/checkout/page.tsx")

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.ok(from >= 0 && to > from, `no se encontró el bloque ${start}`)
  return source.slice(from, to)
}

// Lo que /login hace con su `?redirect=`.
const redirectAfterAuth = (href: string) =>
  getSafeRedirect(new URL(href, "https://beyonix.test").searchParams.get("redirect"))

test("A. invitado -> Finalizar compra: va a /login con regreso al checkout", () => {
  assert.equal(getCheckoutEntryHref(false), "/login?redirect=%2Fcheckout")
  assert.equal(redirectAfterAuth(getCheckoutEntryHref(false)), CHECKOUT_PATH)
})

test("con sesión: Finalizar compra sigue yendo directo al checkout", () => {
  assert.equal(getCheckoutEntryHref(true), "/checkout")
})

test("URL directa y refresh de /checkout: espera auth y envía al invitado a login sin borrar el carrito", () => {
  assert.match(checkout, /if \(!isLoading && !user\) router\.replace\(getCheckoutEntryHref\(false\)\)/)
  assert.match(checkout, /if \(isLoading \|\| !user\) return null\n\n  if \(!mounted \|\| !isCartReady\)/)
  assert.equal(getCheckoutEntryHref(false), "/login?redirect=%2Fcheckout")
  assert.equal(redirectAfterAuth(getCheckoutEntryHref(false)), CHECKOUT_PATH)
  const authGuard = between(checkout, "useAuth()\n  useEffect(() => {", "  const {\n    cart: items,")
  assert.doesNotMatch(authGuard, /clearCart|sessionStorage\.removeItem/)
})

test("usuario autenticado entra a checkout y el regreso de login no genera loop", () => {
  assert.equal(getCheckoutEntryHref(true), CHECKOUT_PATH)
  assert.equal(redirectAfterAuth(getCheckoutEntryHref(false)), CHECKOUT_PATH)
  assert.equal(buildLoginHref("/login?redirect=/checkout"), "/login")
})

test("el botón del carrito usa el destino según la sesión y no toca el carrito", () => {
  const onCheckout = between(drawer, "onCheckout={() => {", "}}")
  assert.match(onCheckout, /router\.push\(getCheckoutEntryHref\(isAuthenticated\)\)/)
  assert.doesNotMatch(onCheckout, /clearCart|removeFromCart|sessionStorage|localStorage/)
  assert.match(drawer, /isAuthenticated = false,/)
  assert.match(wrapper, /const \{ user \} = useAuth\(\)/)
  assert.match(wrapper, /isAuthenticated=\{Boolean\(user\)\}/)
})

test("B. login exitoso: vuelve al destino seguro del ?redirect= (el checkout)", () => {
  assert.match(login, /const redirect = getSafeRedirect\(searchParams\.get\("redirect"\)\)/)
  const begin = between(login, "const beginAuthenticatedRedirect = useCallback(() => {", "}, [redirect, router])")
  assert.match(begin, /router\.replace\(redirect\)/)
  const loginBranch = between(login, 'if (mode === "login") {', "if (!meetsPasswordRequirements(password))")
  assert.match(loginBranch, /beginAuthenticatedRedirect\(\)/)
})

test("E. login fallido: muestra el error, no navega (redirect intacto) y no toca el carrito", () => {
  const loginBranch = between(login, 'if (mode === "login") {', "if (!meetsPasswordRequirements(password))")
  const failure = between(loginBranch, "if (!result.ok) {", "navigationStarted.current = false\n      beginAuthenticatedRedirect()")
  assert.match(failure, /setError\(result\.error \|\| "Error al iniciar sesión"\)/)
  assert.doesNotMatch(failure, /router\.|window\.location|history\./)
  assert.doesNotMatch(login, /clearCart|beyonix-cart/)
})

test("D. registro: la espera de confirmación conserva el redirect y al confirmar vuelve al checkout", () => {
  assert.match(login, /buildLoginHref\(redirect, \{ "verificar-email": normalizedEmail \}\)/)
  assert.match(login, /window\.location\.assign\(redirect\)/)
  // Registro fallido (email existente, validación, error temporal): sólo el error.
  assert.match(login, /if \(!result\.ok\) \{\n      setError\(result\.error \|\| "Error al crear cuenta"\)\n      return\n    \}/)
  // "Volver al inicio de sesión" desde la confirmación tampoco lo pierde.
  assert.match(login, /router\.replace\(buildLoginHref\(redirect\), \{ scroll: false \}\)/)
  assert.equal(
    redirectAfterAuth(buildLoginHref(CHECKOUT_PATH, { "verificar-email": "ana.peña@example.com" })),
    CHECKOUT_PATH,
  )
})

test("F. cambiar login <-> registro no navega: el ?redirect= y el carrito quedan intactos", () => {
  const modeChange = between(login, "const handleModeChange = (", "const getRegisterDeliveryAddress")
  assert.doesNotMatch(modeChange, /router\.|window\.location|history\.|clearCart/)
})

test("G. refresh en /login: el carrito invitado se rehidrata desde sessionStorage y el dueño se resuelve como invitado", () => {
  assert.match(cartContext, /const stored = sessionStorage\.getItem\(CART_STORAGE_KEY\)\n\s+setCart\(stored \? normalizeCart\(JSON\.parse\(stored\)\) : \[\]\)/)
  assert.match(cartContext, /if \(!session\?\.user\) \{\n\s+markGuestIfUnknown\(\)/)
  assert.match(cartContext, /if \(event === "INITIAL_SESSION" && !session\?\.user\) \{\n\s+markGuestIfUnknown\(\)/)
})

test("C/H. SIGNED_IN traspasa el carrito del invitado; SIGNED_OUT sólo lo devuelve si la sesión se rechazó en /login", () => {
  const restore = between(cartContext, "const restoreUserCart = (userId: string) => {", "const markGuestIfUnknown")
  assert.match(restore, /resolveCartOnSignIn\(\{\n\s+owner: cartOwnerRef\.current,/)
  assert.match(restore, /currentCart: cartRef\.current,/)
  assert.match(restore, /writeCartStorage\(userId, nextCart\)/)
  assert.match(restore, /handoff && window\.location\.pathname\.startsWith\("\/login"\)/)
  const signOut = between(cartContext, 'if (event !== "SIGNED_OUT") return', "return () => subscription.unsubscribe()")
  assert.match(signOut, /resolveCartOnSignOut\(\n\s+guestCartHandoffRef\.current,\n\s+\)/)
  assert.match(cartContext, /if \(!pathname\?\.startsWith\("\/login"\)\) guestCartHandoffRef\.current = null/)
})

test("J. redirect externo o inválido: se descarta y nunca sale de BEYONIX", () => {
  for (const hostile of [
    "https://sitio-malicioso.com",
    "//sitio-malicioso.com/checkout",
    "/\\sitio-malicioso.com",
    "javascript:alert(1)",
    "/login?redirect=/checkout",
  ]) {
    assert.equal(buildLoginHref(hostile), "/login", hostile)
    assert.equal(redirectAfterAuth(`/login?redirect=${encodeURIComponent(hostile)}`), "/", hostile)
  }
  assert.equal(buildLoginHref(null, { "verificar-email": "ana@example.com" }), "/login?verificar-email=ana%40example.com")
})
