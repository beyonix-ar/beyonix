import assert from "node:assert/strict"
import test from "node:test"

import {
  createHistoryStack,
  parseHistoryStack,
  previousInternalUrl,
  recordNavigation,
  restoreHistoryStack,
  type HistoryStackState,
} from "./history-stack.ts"

/** Simula el navegador: history.length crece con push, no con replace ni pop. */
function browser(firstUrl: string) {
  let length = 1
  let state: HistoryStackState = createHistoryStack(firstUrl, length)
  return {
    push(url: string) { length += 1; state = recordNavigation(state, url, length, "change") },
    replace(url: string) { state = recordNavigation(state, url, length, "change") },
    back(url: string) { state = recordNavigation(state, url, length, "pop") },
    /** Push después de un Atrás: el navegador trunca el "adelante" (length no crece). */
    pushAfterBack(url: string) { state = recordNavigation(state, url, length, "change") },
    previous: () => previousInternalUrl(state, length),
    get stack() { return state.stack },
  }
}

test("Home → Productos → Categoría → Producto: Atrás recorre la misma secuencia y no sale antes de tiempo", () => {
  const nav = browser("/")
  nav.push("/productos")
  nav.push("/categorias/hogar")
  nav.push("/productos/encendedor")
  assert.equal(nav.previous(), "/categorias/hogar")
  nav.back("/categorias/hogar")
  assert.equal(nav.previous(), "/productos")
  nav.back("/productos")
  assert.equal(nav.previous(), "/")
  nav.back("/")
  assert.equal(nav.previous(), null, "en la primera entrada no hay Atrás interno: el botón usa su ruta de respaldo")
})

test("Productos → Login: 'Volver' vuelve a Productos", () => {
  const nav = browser("/productos")
  nav.push("/login?redirect=%2Fproductos")
  assert.equal(nav.previous(), "/productos")
})

test("Cuenta → Mis compras (replace) → Pedido: la pantalla anterior al pedido es Mis compras", () => {
  const nav = browser("/cuenta")
  nav.replace("/cuenta?tab=ordenes")
  nav.push("/cuenta/compras/42")
  assert.equal(nav.previous(), "/cuenta?tab=ordenes")
  nav.back("/cuenta?tab=ordenes")
  assert.equal(nav.previous(), null, "Mis compras reemplazó a Cuenta: no hay entrada interna anterior")
})

test("entrada directa (link externo o pestaña nueva): sin historial interno", () => {
  const nav = browser("/cuenta/compras/42")
  assert.equal(nav.previous(), null)
})

test("Atrás y luego un link nuevo: la pila puede quedar corta, nunca larga (no saca al cliente del sitio)", () => {
  const nav = browser("/")
  nav.push("/productos")
  nav.push("/productos/a")
  nav.back("/productos")
  nav.pushAfterBack("/productos/b")
  assert.deepEqual(nav.stack, ["/", "/productos/b"], "sin crecimiento de history.length se trata como replace")
  assert.ok(nav.previous(), "sigue habiendo historial interno: Volver usa router.back")
  nav.back("/productos")
  assert.equal(nav.previous(), null, "subestima: el Volver usa la ruta de respaldo en vez de arriesgar salir")
})

test("Atrás y luego un replace (pestaña de Cuenta): no se inventa una entrada", () => {
  const nav = browser("/cuenta")
  nav.push("/cuenta/compras/42")
  nav.back("/cuenta")
  nav.replace("/cuenta?tab=ordenes")
  assert.deepEqual(nav.stack, ["/cuenta?tab=ordenes"])
  assert.equal(nav.previous(), null)
})

test("recarga: se conserva la pila si termina en la URL actual; si no, arranca de cero", () => {
  const saved = { stack: ["/", "/productos"], length: 2 }
  assert.deepEqual(restoreHistoryStack(saved, "/productos", 2).stack, ["/", "/productos"])
  assert.deepEqual(restoreHistoryStack(saved, "/contacto", 1).stack, ["/contacto"])
  assert.deepEqual(restoreHistoryStack(null, "/", 1).stack, ["/"])
})

test("history.length < 2 nunca permite router.back (evita salir del sitio)", () => {
  const state = { stack: ["/", "/productos"], length: 2 }
  assert.equal(previousInternalUrl(state, 1), null)
  assert.equal(previousInternalUrl(state, 2), "/")
})

test("parseHistoryStack descarta datos corruptos", () => {
  assert.equal(parseHistoryStack("{"), null)
  assert.equal(parseHistoryStack(JSON.stringify({ stack: [1, 2] })), null)
  assert.deepEqual(parseHistoryStack(JSON.stringify({ stack: ["/"], length: 3 })), { stack: ["/"], length: 3 })
})
