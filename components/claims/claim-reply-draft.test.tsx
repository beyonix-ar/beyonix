import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

// Borrador de "Atención al cliente" con React real (JSDOM): el editor usa
// useClaimReplyDraft igual que AdminClaimManager -- textarea controlado,
// datos del reclamo que llegan por props y envío que limpia sólo si salió OK.

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}

type DraftModule = typeof import("./use-claim-reply-draft")
type StorageModule = typeof import("../../lib/admin/claim-reply-draft")
type Root = import("react-dom/client").Root
let useClaimReplyDraft: DraftModule["useClaimReplyDraft"]
let getClaimReplyDraftKey: StorageModule["getClaimReplyDraftKey"]
let root: Root

test.before(async () => {
  const { createRoot } = await import("react-dom/client")
  ;({ useClaimReplyDraft } = await import("./use-claim-reply-draft"))
  ;({ getClaimReplyDraftKey } = await import("../../lib/admin/claim-reply-draft"))
  root = createRoot(document.getElementById("root")!)
})

interface ClaimData {
  id: number
  status: string
  updated_at: string
  messages: string[]
}

function ReplyEditor({
  orderId,
  claim,
  onSend,
}: {
  orderId: number
  claim: ClaimData
  onSend: (text: string) => Promise<boolean>
}) {
  const [response, setResponse, clearResponse] = useClaimReplyDraft(orderId, claim.id)
  return (
    <div>
      <p data-status>{claim.status}</p>
      <ul>{claim.messages.map((message) => <li key={message}>{message}</li>)}</ul>
      <textarea value={response} onChange={(event) => setResponse(event.target.value)} />
      <button
        type="button"
        onClick={async () => {
          const sent = await onSend(response.trim())
          if (sent) clearResponse()
        }}
      >
        Enviar respuesta
      </button>
    </div>
  )
}

const claimA: ClaimData = { id: 11, status: "en_revision", updated_at: "2026-09-23T10:00:00Z", messages: ["Hola, llegó roto"] }
const claimB: ClaimData = { id: 22, status: "en_revision", updated_at: "2026-09-23T11:00:00Z", messages: ["¿Cuándo llega?"] }
let sendResult = true
const sent: string[] = []
const onSend = async (text: string) => {
  sent.push(text)
  return sendResult
}

const render = (orderId: number, claim: ClaimData) =>
  act(async () => root.render(<ReplyEditor orderId={orderId} claim={claim} onSend={onSend} />))
const textarea = () => document.querySelector("textarea") as HTMLTextAreaElement
const type = (value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!
    setter.call(textarea(), value)
    textarea().dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
const clickSend = () =>
  act(async () => {
    ;(document.querySelector("button") as HTMLButtonElement).click()
  })
const stored = (orderId: number, claimId: number) =>
  dom.window.sessionStorage.getItem(getClaimReplyDraftKey(orderId, claimId))

test("8. refresh con textarea vacío: comportamiento normal, sin borrador guardado", async () => {
  await render(100, claimA)
  await render(100, { ...claimA, updated_at: "2026-09-23T10:00:20Z" })
  assert.equal(textarea().value, "")
  assert.equal(stored(100, 11), null)
})

test("1. escribir + refresh de datos (nuevo objeto, mismos ids) -> el texto permanece", async () => {
  await type("Hola María, ya revisamos tu caso")
  await render(100, { ...claimA, updated_at: "2026-09-23T10:00:40Z" })
  assert.equal(textarea().value, "Hola María, ya revisamos tu caso")
  assert.equal(stored(100, 11), "Hola María, ya revisamos tu caso")
})

test("2. escribir + llega un mensaje nuevo del cliente -> el texto permanece", async () => {
  await render(100, { ...claimA, messages: [...claimA.messages, "¿Novedades?"] })
  assert.equal(document.querySelectorAll("li").length, 2)
  assert.equal(textarea().value, "Hola María, ya revisamos tu caso")
})

test("3. escribir + cambia el estado del reclamo -> el texto permanece", async () => {
  await render(100, { ...claimA, status: "aprobado", updated_at: "2026-09-23T10:01:00Z" })
  assert.equal(document.querySelector("[data-status]")?.textContent, "aprobado")
  assert.equal(textarea().value, "Hola María, ya revisamos tu caso")
})

test("remount del editor (lo que antes hacía el spinner del detalle) -> recupera el borrador", async () => {
  await act(async () => root.render(<p>Cargando…</p>))
  assert.equal(document.querySelector("textarea"), null)
  await render(100, claimA)
  assert.equal(textarea().value, "Hola María, ya revisamos tu caso")
})

test("5. envío fallido -> el textarea conserva el texto", async () => {
  sendResult = false
  await clickSend()
  assert.equal(sent.at(-1), "Hola María, ya revisamos tu caso")
  assert.equal(textarea().value, "Hola María, ya revisamos tu caso")
  assert.equal(stored(100, 11), "Hola María, ya revisamos tu caso")
})

test("6. cambiar a otro pedido/reclamo -> no mezcla borradores", async () => {
  await render(200, claimB)
  assert.equal(textarea().value, "")
  await type("Respuesta para el pedido B")
  assert.equal(stored(200, 22), "Respuesta para el pedido B")
  assert.equal(stored(100, 11), "Hola María, ya revisamos tu caso")
})

test("7. volver al pedido anterior -> recupera su propio borrador", async () => {
  await render(100, claimA)
  assert.equal(textarea().value, "Hola María, ya revisamos tu caso")
  await render(200, claimB)
  assert.equal(textarea().value, "Respuesta para el pedido B")
})

test("4. envío exitoso -> se limpia el textarea y su respaldo (sólo el de ese reclamo)", async () => {
  await render(100, claimA)
  sendResult = true
  await clickSend()
  assert.equal(textarea().value, "")
  assert.equal(stored(100, 11), null)
  assert.equal(stored(200, 22), "Respuesta para el pedido B")
})

test("borrarlo a mano limpia el respaldo", async () => {
  await render(200, claimB)
  await type("")
  assert.equal(textarea().value, "")
  assert.equal(stored(200, 22), null)
  await act(async () => root.unmount())
})
