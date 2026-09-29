import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

import { TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE } from "../../lib/orders/transfer-verification-reasons"
import type { SupabasePedido } from "../../lib/supabase/types"

// Flujo de transferencia con React real (JSDOM): "Ya realicé la
// transferencia" valida con el titular del paso 1 (sin volver a pedirlo) y,
// si no hay coincidencia, abre un modal de advertencia con 3 salidas.

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
  BroadcastChannel: undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local-test.invalid"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-test-key"

type FlowModule = typeof import("./transfer-flow")
type Root = import("react-dom/client").Root
let TransferFlow: FlowModule["TransferFlow"]
let root: Root

type VerifyReply = { status: number; body: Record<string, unknown> } | "network-error"
const verifyReplies: VerifyReply[] = []
const verifyBodies: Array<Record<string, unknown>> = []
const holderBodies: Array<Record<string, unknown>> = []
const BANK_TRANSFER = { alias: "beyonix.pagos", cvu: "0000003100012345678901", accountHolder: "BEYONIX SRL" }
let updatedCalls = 0
// Cada escenario monta el flujo desde cero (sin arrastrar el paso anterior).
let mountKey = 0

const REMOVED_COPY = [
  "Estos datos pueden ser distintos a los de la persona que realizó la compra.",
  "Podés ingresar uno o todos sus nombres, como figuran en la cuenta (ej.: Romina Ayelen).",
  "Apellido/s de la persona titular de esa cuenta (ej.: Pérez).",
  "Documento del titular de la cuenta desde donde vas a transferir.",
]

function order(overrides: Partial<SupabasePedido> = {}): SupabasePedido {
  return {
    id: 42,
    usuario_id: "u-1",
    created_at: new Date().toISOString(),
    estado: "pendiente",
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    total: 25000,
    external_amount_due: 25000,
    transfer_verification_status: null,
    transfer_payer_first_name: "Romina Ayelen",
    transfer_payer_last_name: "Pérez",
    transfer_payer_dni: "30123456",
    ...overrides,
  } as SupabasePedido
}

test.before(async () => {
  const { createRoot } = await import("react-dom/client")
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith("/api/transferencia/42/verificar") && init?.method === "POST") {
      verifyBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      const reply = verifyReplies.shift() ?? { status: 200, body: { status: "verified" } }
      if (reply === "network-error") throw new TypeError("Network unavailable")
      return Response.json(reply.body, { status: reply.status })
    }
    // Mismo contrato que app/api/transferencia/[orderId]/titular/route.ts.
    if (path.endsWith("/api/transferencia/42/titular") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      holderBodies.push(body)
      return Response.json({ saved: true, amount: 25000, bankTransfer: BANK_TRANSFER })
    }
    return Response.json({ error: "sin datos en el test" }, { status: 404 })
  })
  ;({ TransferFlow } = await import("./transfer-flow"))
  root = createRoot(document.getElementById("root") as HTMLElement)
})

test.after(async () => {
  await act(async () => root.unmount())
  mock.restoreAll()
})

async function render(pedido: SupabasePedido, bankTransfer = true) {
  const { createElement } = await import("react")
  verifyBodies.length = 0
  holderBodies.length = 0
  updatedCalls = 0
  await act(async () => {
    root.render(
      createElement(TransferFlow, {
        key: String(++mountKey),
        orderLoading: false,
        sessionExpired: false,
        orderError: "",
        order: pedido,
        reservation: {
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          serverNow: new Date().toISOString(),
          receivedAt: performance.now(),
        },
        bankTransfer: bankTransfer ? BANK_TRANSFER : null,
        paymentConfirmed: false,
        onUpdated: () => {
          updatedCalls += 1
        },
        loginHref: "/login",
        ordersHref: "/cuenta/compras",
        homeHref: "/",
      }),
    )
  })
}

const text = () => document.body.textContent ?? ""
const modal = () => document.querySelector("[data-transfer-verification-failed]")
function button(label: string, scope: ParentNode = document) {
  const found = [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim().includes(label))
  assert.ok(found, `botón "${label}"`)
  return found as HTMLButtonElement
}
async function click(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
  })
}
async function typeInto(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement
  assert.ok(input, `input #${id}`)
  await act(async () => {
    // Setter nativo: React sólo registra el cambio si el valor cambió "por debajo".
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
}
async function pressKey(key: string, shiftKey = false) {
  const event = new dom.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })
  await act(async () => {
    ;(document.activeElement ?? document.body).dispatchEvent(event)
  })
  return event
}

test("paso 1: sin los textos de ayuda eliminados; sólo nombre, apellido y DNI/CUIT", async () => {
  await render(order({ transfer_payer_first_name: null, transfer_payer_last_name: null, transfer_payer_dni: null }), false)
  assert.match(text(), /¿Desde qué cuenta vas a transferir\?/)
  for (const copy of REMOVED_COPY) assert.equal(text().includes(copy), false, copy)
  assert.equal(document.querySelector("[data-transfer-holder-notice]"), null)
  assert.deepEqual(
    [...document.querySelectorAll("input")].map((input) => input.id),
    ["transfer-holder-nombre", "transfer-holder-apellido", "transfer-holder-dni"],
  )
  assert.match(text(), /Paso 1 de 3 · Titular/)
})

test("'Ya realicé la transferencia' valida directo con el titular del paso 1 y el importe del servidor; si coincide, avanza", async () => {
  await render(order())
  assert.match(text(), /Paso 2 de 3 · Transferencia/)
  verifyReplies.push({ status: 200, body: { status: "verified", verified: true } })
  await click(button("Ya realicé la transferencia"))

  assert.deepEqual(verifyBodies, [{ nombre: "Romina Ayelen", apellido: "Pérez", dni: "30123456", monto: 25000 }])
  assert.equal(updatedCalls, 1, "refresca el pedido para mostrar el pago confirmado")
  assert.equal(modal(), null)
  // Nunca aparece otro formulario que vuelva a pedir los datos.
  assert.equal(document.querySelectorAll("input").length, 0)
  assert.doesNotMatch(text(), /Validá tu transferencia|Monto exacto transferido/)
})

test("sin coincidencia: modal ámbar (alertdialog) con 3 acciones, sin repetir el formulario", async () => {
  await render(order())
  verifyReplies.push({
    status: 200,
    body: { status: "awaiting_transfer", retryable: true, retryAfterSeconds: 10, proofUploadAvailable: true, message: "Todavía no encontramos tu transferencia." },
  })
  await click(button("Ya realicé la transferencia"))

  const dialog = modal()
  assert.ok(dialog, "abre el modal")
  assert.equal(dialog.getAttribute("role"), "alertdialog")
  assert.equal(dialog.getAttribute("aria-modal"), "true")
  assert.match(dialog.className, /account-warning-border/)
  assert.doesNotMatch(dialog.outerHTML, /account-info/, "nada de estilo informativo azul")
  assert.ok(dialog.querySelector("svg.lucide-triangle-alert, svg.lucide-alert-triangle"), "triángulo con !")
  assert.match(dialog.textContent ?? "", /No pudimos validar tu transferencia/)
  assert.match(dialog.textContent ?? "", /Todavía no encontramos tu transferencia\./)
  assert.match(dialog.textContent ?? "", /Romina Ayelen Pérez · DNI\/CUIT 30123456/)
  button("Subir el comprobante de pago", dialog)
  button("Cambiar datos del titular", dialog)
  const retry = button("Podés volver a verificar en 10 s", dialog)
  assert.equal(retry.disabled, true, "respeta la espera del servidor antes de reintentar")
  // Con el reintento en cooldown, el foco va a la primera acción habilitada
  // (nunca queda detrás del modal).
  assert.equal(document.activeElement, button("Subir el comprobante de pago", dialog))
  assert.equal(document.querySelectorAll("input").length, 0, "no hay un segundo formulario")
})

test("modal: 'Volver a verificar' repite la validación con los mismos datos", async () => {
  await render(order())
  verifyReplies.push({ status: 200, body: { status: "awaiting_transfer", retryable: true, retryAfterSeconds: 0, proofUploadAvailable: true } })
  await click(button("Ya realicé la transferencia"))
  verifyReplies.push({ status: 200, body: { status: "verified", verified: true } })
  await click(button("Volver a verificar", modal() as HTMLElement))

  assert.equal(verifyBodies.length, 2)
  assert.deepEqual(verifyBodies[1], verifyBodies[0])
  assert.equal(modal(), null)
  assert.equal(updatedCalls, 1)
})

test("modal: 'Cambiar datos del titular' vuelve al paso 1 y 'Subir el comprobante' al uploader", async () => {
  await render(order())
  verifyReplies.push({ status: 200, body: { status: "manual_review", retryable: false, proofUploadAvailable: true, message: "No pudimos validar tu transferencia automáticamente." } })
  await click(button("Ya realicé la transferencia"))
  await click(button("Cambiar datos del titular", modal() as HTMLElement))
  assert.equal(modal(), null)
  assert.match(text(), /¿Desde qué cuenta vas a transferir\?/)
  assert.equal((document.getElementById("transfer-holder-nombre") as HTMLInputElement).value, "Romina Ayelen")

  await render(order())
  verifyReplies.push({ status: 200, body: { status: "manual_review", retryable: false, proofUploadAvailable: true } })
  await click(button("Ya realicé la transferencia"))
  await click(button("Subir el comprobante de pago", modal() as HTMLElement))
  assert.equal(modal(), null)
  assert.match(text(), /Adjuntar comprobante/)
})

test("fallo de red: modal con el comprobante disponible; conflicto de stock: sin modal de 'no encontramos'", async () => {
  await render(order())
  verifyReplies.push("network-error")
  await click(button("Ya realicé la transferencia"))
  assert.match(modal()?.textContent ?? "", /No pudimos conectarnos para verificar tu transferencia\./)
  button("Subir el comprobante de pago", modal() as HTMLElement)

  // Contrato real de safeVerificationResponse (verificar/route.ts): el
  // conflicto de stock llega sólo como outcome "stock_conflict".
  await render(order())
  verifyReplies.push({
    status: 200,
    body: {
      status: "manual_review",
      outcome: "stock_conflict",
      verified: false,
      manualReviewRequired: true,
      retryable: false,
      proofUploadAvailable: true,
      message: TRANSFER_STOCK_CONFLICT_CUSTOMER_MESSAGE,
    },
  })
  await click(button("Ya realicé la transferencia"))
  assert.equal(modal(), null)
  assert.equal(updatedCalls, 1)
  assert.match(text(), /Paso 3 de 3 · Resultado/)
})

test("si el servidor niega el comprobante, el modal no lo ofrece", async () => {
  await render(order())
  verifyReplies.push({ status: 400, body: { error: "Este pedido no corresponde a transferencia bancaria.", proofUploadAvailable: false } })
  await click(button("Ya realicé la transferencia"))
  const dialog = modal() as HTMLElement
  assert.ok(dialog)
  assert.equal([...dialog.querySelectorAll("button")].some((node) => /Subir el comprobante/.test(node.textContent ?? "")), false)
  button("Volver a verificar", dialog)
  button("Cambiar datos del titular", dialog)
})

test("links y pseudo-botones del flujo muestran cursor pointer", async () => {
  await render(order())
  assert.match(button("Cambiar datos del titular").className, /\bcursor-pointer\b/)
  for (const copy of [...document.querySelectorAll("button")]) {
    assert.match(copy.className, /cursor-pointer/, copy.textContent ?? "")
  }
})

const actionOrder = (dialog: Element) =>
  [...dialog.querySelectorAll("[data-transfer-failure-kind] button")].map((node) => (node.textContent ?? "").trim())

test("todavía no apareció: mensaje propio y 'Volver a verificar' como acción principal", async () => {
  await render(order())
  verifyReplies.push({
    status: 200,
    body: { status: "awaiting_transfer", outcome: "not_found", retryable: true, retryAfterSeconds: 0, proofUploadAvailable: true, message: "Tu transferencia todavía no aparece. Puede tardar unos minutos en reflejarse." },
  })
  await click(button("Ya realicé la transferencia"))
  const dialog = modal() as HTMLElement
  assert.match(dialog.textContent ?? "", /Tu transferencia todavía no aparece/)
  assert.doesNotMatch(dialog.textContent ?? "", /No pudimos hacer coincidir/)
  assert.deepEqual(actionOrder(dialog), ["Volver a verificar", "Subir el comprobante de pago", "Cambiar datos del titular"])
})

test("apareció pero no coincide: mensaje distinto y 'Cambiar datos del titular' como acción principal", async () => {
  await render(order())
  verifyReplies.push({
    status: 200,
    body: { status: "manual_review", outcome: "not_matching", retryable: true, retryAfterSeconds: 0, proofUploadAvailable: true, message: "No pudimos hacer coincidir la transferencia con los datos ingresados." },
  })
  await click(button("Ya realicé la transferencia"))
  const dialog = modal() as HTMLElement
  assert.match(dialog.textContent ?? "", /No pudimos hacer coincidir la transferencia con los datos ingresados\./)
  assert.doesNotMatch(dialog.textContent ?? "", /todavía no aparece/)
  assert.deepEqual(actionOrder(dialog), ["Cambiar datos del titular", "Volver a verificar", "Subir el comprobante de pago"])
})

test("encontrada pero falta confirmar: nunca dice 'no encontramos'; el reintento confirma", async () => {
  await render(order())
  verifyReplies.push({
    status: 200,
    body: { status: "manual_review", outcome: "confirming", retryable: true, retryAfterSeconds: 0, proofUploadAvailable: true, message: "Encontramos tu transferencia y estamos terminando de confirmarla. Volvé a verificar en unos segundos." },
  })
  await click(button("Ya realicé la transferencia"))
  const dialog = modal() as HTMLElement
  assert.match(dialog.textContent ?? "", /Estamos confirmando tu pago/)
  assert.doesNotMatch(dialog.textContent ?? "", /no aparece|no encontramos/i)
  verifyReplies.push({ status: 200, body: { status: "verified", outcome: "verified", verified: true } })
  await click(button("Volver a verificar", dialog))
  assert.equal(modal(), null)
  assert.equal(updatedCalls, 1)
})

test("titular corregido desde el modal: la siguiente verificación usa los datos nuevos", async () => {
  await render(order())
  verifyReplies.push({ status: 200, body: { status: "manual_review", outcome: "not_matching", retryable: true, retryAfterSeconds: 0, proofUploadAvailable: true } })
  await click(button("Ya realicé la transferencia"))
  assert.deepEqual(verifyBodies[0], { nombre: "Romina Ayelen", apellido: "Pérez", dni: "30123456", monto: 25000 })

  await click(button("Cambiar datos del titular", modal() as HTMLElement))
  assert.equal(modal(), null)
  assert.match(text(), /¿Desde qué cuenta vas a transferir\?/)

  await typeInto("transfer-holder-nombre", "María José")
  await typeInto("transfer-holder-apellido", "Núñez Güemes")
  await typeInto("transfer-holder-dni", "27123456")
  await click(button("Continuar a los datos de transferencia"))

  assert.deepEqual(holderBodies, [{ nombre: "María José", apellido: "Núñez Güemes", dni: "27123456" }])
  assert.match(text(), /Paso 2 de 3 · Transferencia/)

  verifyReplies.push({ status: 200, body: { status: "verified", outcome: "verified", verified: true } })
  await click(button("Ya realicé la transferencia"))

  assert.equal(verifyBodies.length, 2)
  assert.deepEqual(verifyBodies[1], { nombre: "María José", apellido: "Núñez Güemes", dni: "27123456", monto: 25000 })
})

test("modal: Tab / Shift+Tab quedan atrapados dentro del diálogo", async () => {
  await render(order())
  verifyReplies.push({ status: 200, body: { status: "awaiting_transfer", outcome: "not_found", retryable: true, retryAfterSeconds: 10, proofUploadAvailable: true } })
  await click(button("Ya realicé la transferencia"))
  const dialog = modal() as HTMLElement
  const closeButton = dialog.querySelector<HTMLButtonElement>('button[aria-label="Cerrar"]')
  assert.ok(closeButton)
  const lastAction = button("Cambiar datos del titular", dialog)

  // Último habilitado + Tab -> primero (la X); primero + Shift+Tab -> último.
  await act(async () => lastAction.focus())
  assert.equal((await pressKey("Tab")).defaultPrevented, true)
  assert.equal(document.activeElement, closeButton)
  assert.equal((await pressKey("Tab", true)).defaultPrevented, true)
  assert.equal(document.activeElement, lastAction)

  // Entre medio, Tab sigue el orden nativo (no se intercepta).
  await act(async () => button("Subir el comprobante de pago", dialog).focus())
  assert.equal((await pressKey("Tab")).defaultPrevented, false)

  // Foco escapado detrás del modal: Tab lo devuelve adentro.
  const behindModal = button("Cambiar datos del titular")
  assert.equal(dialog.contains(behindModal), false)
  await act(async () => behindModal.focus())
  assert.equal(document.activeElement, behindModal)
  assert.equal((await pressKey("Tab")).defaultPrevented, true)
  assert.ok(dialog.contains(document.activeElement))
})

test("modal: al cerrar, el foco vuelve a 'Ya realicé la transferencia' (Escape y X)", async () => {
  await render(order())
  verifyReplies.push({ status: 200, body: { status: "awaiting_transfer", outcome: "not_found", retryable: true, retryAfterSeconds: 0, proofUploadAvailable: true } })
  const trigger = button("Ya realicé la transferencia")
  await click(trigger)
  assert.ok(modal())
  await pressKey("Escape")
  assert.equal(modal(), null)
  assert.equal(document.activeElement, trigger)

  verifyReplies.push({ status: 200, body: { status: "awaiting_transfer", outcome: "not_found", retryable: true, retryAfterSeconds: 0, proofUploadAvailable: true } })
  await click(trigger)
  const closeButton = (modal() as HTMLElement).querySelector<HTMLButtonElement>('button[aria-label="Cerrar"]')
  assert.ok(closeButton)
  await click(closeButton)
  assert.equal(modal(), null)
  assert.equal(document.activeElement, trigger)
})

test("modal: si el disparador quedó en espera, el foco vuelve a la otra acción del paso", async () => {
  await render(order())
  verifyReplies.push({ status: 200, body: { status: "awaiting_transfer", outcome: "not_found", retryable: true, retryAfterSeconds: 10, proofUploadAvailable: true } })
  const trigger = button("Ya realicé la transferencia")
  await click(trigger)
  await pressKey("Escape")
  assert.equal(modal(), null)
  assert.equal(trigger.disabled, true)
  assert.equal(document.activeElement?.textContent?.trim(), "Cambiar datos del titular")
  assert.notEqual(document.activeElement, document.body)
})
