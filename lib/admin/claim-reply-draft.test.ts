import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CLAIM_REPLY_DRAFT_PREFIX,
  getClaimReplyDraftKey,
  readClaimReplyDraft,
  writeClaimReplyDraft,
  type ClaimReplyDraftStorage,
} from "./claim-reply-draft.ts"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

function memoryStorage(): ClaimReplyDraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  }
}

test("borrador: clave por pedido + reclamo, sin mezclar", () => {
  assert.equal(getClaimReplyDraftKey(100, 11), `${CLAIM_REPLY_DRAFT_PREFIX}100:11`)
  assert.notEqual(getClaimReplyDraftKey(100, 11), getClaimReplyDraftKey(200, 11))
  assert.notEqual(getClaimReplyDraftKey(100, 11), getClaimReplyDraftKey(100, 12))

  const storage = memoryStorage()
  writeClaimReplyDraft(storage, getClaimReplyDraftKey(100, 11), "Hola María")
  assert.equal(readClaimReplyDraft(storage, getClaimReplyDraftKey(100, 11)), "Hola María")
  assert.equal(readClaimReplyDraft(storage, getClaimReplyDraftKey(200, 22)), "")
  // Vacío = borrado manual -> sin respaldo.
  writeClaimReplyDraft(storage, getClaimReplyDraftKey(100, 11), "")
  assert.equal(storage.data.size, 0)
})

test("borrador: sin storage, sin reclamo o con storage bloqueado nunca rompe", () => {
  assert.equal(readClaimReplyDraft(null, "x"), "")
  assert.equal(readClaimReplyDraft(memoryStorage(), null), "")
  writeClaimReplyDraft(null, "x", "texto")
  const blocked: ClaimReplyDraftStorage = {
    getItem: () => { throw new Error("SecurityError") },
    setItem: () => { throw new Error("QuotaExceededError") },
    removeItem: () => { throw new Error("SecurityError") },
  }
  assert.equal(readClaimReplyDraft(blocked, "x"), "")
  assert.doesNotThrow(() => writeClaimReplyDraft(blocked, "x", "texto"))
})

const claimManager = readSource("../../components/claims/admin-claim-manager.tsx")
const pedidos = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")

test("AdminClaimManager: el borrador sólo depende de (pedido, reclamo)", () => {
  assert.match(
    claimManager,
    /const \[response, setResponse, clearResponse\] = useClaimReplyDraft\(pedido\.id, claim\?\.id \?\? null\)/,
  )
  assert.doesNotMatch(claimManager, /const \[response, setResponse\] = useState/)
  // El efecto de cambio de reclamo ya no vacía el textarea.
  const resetEffect = claimManager.slice(
    claimManager.indexOf("setRejectionReason(claim.rejection_reason ?? \"\")\n    setDecisionAction(null)"),
    claimManager.indexOf("}, [claim?.id])"),
  )
  assert.ok(resetEffect.length > 0)
  assert.doesNotMatch(resetEffect, /setResponse|clearResponse/)
  assert.doesNotMatch(claimManager, /setResponse\(""\)/)
  // Se limpia SÓLO tras un envío exitoso.
  const clears = [...claimManager.matchAll(/clearResponse\(\)/g)].map((match) => match.index ?? 0)
  assert.equal(clears.length, 7)
  for (const index of clears) {
    const before = claimManager.slice(Math.max(0, index - 40), index)
    assert.match(before, /if \(sent\)( \{\n\s*)?\s*$/, claimManager.slice(index - 60, index + 20))
  }
})

test("AdminClaimManager: el refresco automático del reclamo sigue activo", () => {
  assert.match(claimManager, /window\.setInterval\(\(\) => void refreshClaim\(\), 20000\)/)
  assert.match(claimManager, /window\.addEventListener\("focus", refreshClaim\)/)
  const hook = readSource("../../hooks/use-pedidos.ts")
  assert.match(hook, /"order_claim_messages",/)
  assert.match(hook, /void loadPedidos\(\{ silent: true \}\)/)
})

test("causa raíz: el cambio de reclamo recarga en silencio y el detalle embebido no se desmonta", () => {
  const handler = pedidos.slice(
    pedidos.indexOf("const handleClaimChange = (pedidoId: number, claim: SupabaseOrderClaim) => {"),
    pedidos.indexOf("const handleRefundUpdated"),
  )
  assert.match(handler, /void reloadPedidos\(\{ silent: true \}\)/)
  assert.doesNotMatch(handler, /void reloadPedidos\(\)/)

  const embedded = pedidos.slice(pedidos.indexOf("  if (initialOrderId) {"), pedidos.indexOf("<PedidoDetailModal\n          embedded"))
  assert.match(embedded, /if \(loading && !previewPedido\) \{/)
  assert.match(embedded, /if \(error && !previewPedido\) \{/)
  assert.doesNotMatch(embedded, /if \(loading\) \{/)
  assert.doesNotMatch(embedded, /if \(error\) \{/)
  // Error posterior: aviso sin desmontar, con reintento silencioso.
  assert.match(embedded, /\{error && \(\s*<AdminInfoBlock tone="danger" role="alert">/)
})
