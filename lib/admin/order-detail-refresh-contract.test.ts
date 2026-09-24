import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Contratos del detalle de pedido frente a refrescos automáticos (polling del
// reclamo cada 20 s, realtime de ordenes/orden_items/order_claims, recargas
// silenciosas). Principio: un refresco actualiza datos remotos pero no puede
// resetear lo que el operador todavía no guardó.

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const claims = readSource("../../components/claims/admin-claim-manager.tsx")
const pedidos = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")
const usePedidos = readSource("../../hooks/use-pedidos.ts")
const scopedState = readSource("../../hooks/use-scoped-state.ts")
const css = readSource("../../app/globals.css")

function sliceFrom(source: string, signature: string) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, signature)
  return source.slice(start, source.indexOf("\n}\n", start))
}

test("Recepción: sin effects que copien props a estado; borradores atados a (pedido, reclamo)", () => {
  const panel = sliceFrom(claims, "export function ReturnInventoryPanel(")
  assert.doesNotMatch(panel, /useEffect\(/, "ningún effect puede reescribir la edición local")
  assert.match(panel, /const draftScope = `\$\{pedido\.id\}:\$\{claim\.id\}`/)
  for (const state of ["drafts", "editingAffectedItems", "affectedDrafts", "confirmationItemId", "notice", "savingAffectedItems", "savingItemId"]) {
    assert.match(panel, new RegExp(`const \\[${state}, set\\w+\\] = useScopedState`), state)
  }
  // Lo remoto se lee de las props en cada render.
  assert.match(panel, /const affectedItems = getClaimAffectedItems\(claim, orderItems\)/)
  // Sólo una confirmación exitosa descarta el borrador del ítem.
  const save = panel.slice(panel.indexOf("const saveItem = async"), panel.indexOf("const confirmationItem ="))
  const success = save.indexOf("returnReceptionAttemptsRef.current[item.id] = null")
  assert.ok(success > 0)
  assert.ok(save.indexOf("delete next[item.id]") > success, "la limpieza ocurre después del OK")
  assert.equal(save.split("delete next[item.id]").length - 1, 1, "no hay otras limpiezas del borrador")
})

test("useScopedState: reset por entidad en el render y escrituras tardías descartadas", () => {
  assert.doesNotMatch(scopedState, /useEffect/)
  assert.match(scopedState, /if \(state\.scope !== scope\) \{\n\s+current = \{ scope, value: initialValue \}/)
  assert.match(scopedState, /if \(previous\.scope !== scope\) return previous/)
})

test("datos remotos con identidad estable: structural sharing en recargas y en el polling del reclamo", () => {
  assert.match(usePedidos, /setPedidos\(\(previous\) => shareUnchanged\(previous, dedupePedidos\(data\.pedidos\)\)\)/)
  const claimChange = sliceFrom(pedidos, "  const handleClaimChange = (")
  assert.match(claimChange, /const nextClaim = shareUnchanged\(previousClaim, claim\)/)
  assert.match(claimChange, /if \(nextClaim === previousClaim\) return currentPedido/)
  assert.match(claimChange, /void reloadPedidos\(\{ silent: true \}\)/, "la recarga posterior sigue siendo silenciosa")
  assert.match(pedidos, /return refreshed \? shareUnchanged\(currentPedido, refreshed\) : currentPedido/)
})

test("Facturación: las derivaciones desde el reclamo dependen de valores, no del objeto remoto", () => {
  const reasonEffect = pedidos.slice(pedidos.indexOf("const linkedClaimId = linkedClaim?.id ?? null"))
  const reasonDeps = reasonEffect.match(/\}, \[([^\]]+)\]\)/)?.[1] ?? ""
  assert.equal(reasonDeps, "manualGestionOverride, linkedClaimId, linkedClaimFailureType, linkedClaimDescription")
  const operationEffect = pedidos.slice(pedidos.indexOf("const cancellationCreditQuantitiesKey = JSON.stringify("))
  const operationDeps = operationEffect.match(/\}, \[\n([\s\S]*?)\n\s+\]\)/)?.[1] ?? ""
  assert.doesNotMatch(operationDeps, /\blinkedClaim,|creditableOrderItems|claimAffectedQuantityByItem|committedQuantityByItem/)
  assert.match(operationDeps, /cancellationCreditQuantitiesKey/)
})

test("Pestañas del detalle: un refresco no vuelve a la pestaña anterior ni desmonta la abierta", () => {
  assert.match(pedidos, /const availableDetailViews = detailTabs\.map\(\(tab\) => tab\.view\)\.join\("\|"\)/)
  assert.match(pedidos, /\}, \[availableDetailViews, pedido\.id, searchParams\]\)/)
  assert.doesNotMatch(pedidos, /\}, \[detailTabs, pedido\.id, searchParams\]\)/)
})

test("Detalle embebido: las recargas nunca reemplazan el detalle por el spinner", () => {
  assert.match(pedidos, /if \(loading && !previewPedido\) \{/)
  assert.doesNotMatch(pedidos, /<PedidoDetailModal[^>]*\bkey=/)
})

test("Chat: ocupa la altura disponible con scroll interno y composer abajo", () => {
  assert.match(css, /\.admin-claim-workspace > main \{\n  display: flex;\n  flex-direction: column;\n  min-height: 0;\n\}/)
  assert.match(css, /\.admin-claim-workspace > main > \.admin-claim-chat-panel \{\n  flex: 1 1 auto;\n  min-height: 0;\n\}/)
  assert.match(css, /@media \(min-width: 1280px\) \{\n  \.admin-claim-workspace > main \{\n    align-self: stretch;\n  \}\n\}/)
  const thread = css.slice(css.indexOf(".admin-claim-chat-thread {\n  flex: 1 1 auto !important;"))
  const body = thread.slice(0, thread.indexOf("}"))
  assert.match(body, /overflow-y: auto !important;/)
  assert.match(body, /contain: size;/)
  assert.match(body, /max-height: none !important;/)
  assert.doesNotMatch(css, /max-height: 260px !important;/)
})
