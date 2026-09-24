import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

import type {
  SupabaseOrderClaim,
  SupabasePedido,
  SupabasePedidoItem,
  SupabaseProducto,
} from "../../lib/supabase/types"

// "Recepción del producto original" con React real (JSDOM). Cada "refetch"
// re-renderiza con objetos NUEVOS (structuredClone), igual que un polling,
// realtime o recarga silenciosa: la edición local del operador no se toca.

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  // notifyOrderNotificationsChanged despacha `new Event(...)` sobre window.
  Event: dom.window.Event,
  BroadcastChannel: undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local-test.invalid"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-test-key"

type PanelModule = typeof import("./admin-claim-manager")
type Root = import("react-dom/client").Root
let ReturnInventoryPanel: PanelModule["ReturnInventoryPanel"]
let root: Root

// Respuestas del endpoint de recepción, en orden. Cada entrada puede quedar
// pendiente (para simular una respuesta que llega tarde).
type ReceptionReply = { ok: boolean; gate?: Promise<void> }
const receptionReplies: ReceptionReply[] = []
const receptionBodies: Array<Record<string, unknown>> = []
let updatedCalls = 0

test.before(async () => {
  const { createRoot } = await import("react-dom/client")
  const { supabase } = await import("../../lib/supabase/client")
  mock.method(supabase.auth, "getSession", async () => ({
    data: { session: { access_token: "test-token" } },
    error: null,
  }))
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.includes("/return-inventory/") && init?.method === "PATCH") {
      receptionBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
      const reply = receptionReplies.shift() ?? { ok: true }
      await reply.gate
      return reply.ok
        ? Response.json({ ok: true })
        : Response.json({ error: "No se pudo registrar la recepción." }, { status: 500 })
    }
    throw new Error(`Request inesperado en el test: ${path}`)
  })
  ;({ ReturnInventoryPanel } = await import("./admin-claim-manager"))
  root = createRoot(document.getElementById("root")!)
})

test.after(async () => {
  await act(async () => root.unmount())
  mock.restoreAll()
})

function producto(id: number, nombre: string, stock: number): SupabaseProducto {
  return {
    id,
    nombre,
    slug: `producto-${id}`,
    descripcion: null,
    precio: 1000,
    precio_anterior: null,
    descuento: null,
    cuotas_2_habilitadas: false,
    cuotas_3_habilitadas: false,
    cuotas_6_habilitadas: false,
    stock,
    categoria_id: null,
    destacado: false,
    activo: true,
    imagen_principal: null,
    video_url: null,
    created_at: "2026-09-01T00:00:00Z",
  }
}

function item(id: number, orderId: number, cantidad: number, product: SupabaseProducto, extra: Partial<SupabasePedidoItem> = {}): SupabasePedidoItem {
  return { id, orden_id: orderId, producto_id: product.id, cantidad, precio: 1000, productos: product, ...extra }
}

const auricular = producto(1, "Auricular Ñandú", 4)
const parlante = producto(2, "Parlante Güemes", 10)

const pedidoA: SupabasePedido = {
  id: 500,
  usuario_id: null,
  estado: "entregado",
  total: 50000,
  created_at: "2026-09-19T12:00:00Z",
  orden_items: [item(71, 500, 1, auricular), item(72, 500, 3, parlante)],
}

const claimA: SupabaseOrderClaim = {
  id: 900,
  order_id: 500,
  user_id: "cliente",
  claim_type: "garantia_beyonix",
  status: "aprobado",
  resolution: "cambio_producto",
  description: "",
  affected_items: [
    { order_item_id: 71, quantity: 1 },
    { order_item_id: 72, quantity: 3 },
  ],
  order_claim_messages: [],
  created_at: "2026-09-19T12:00:00Z",
  updated_at: "2026-09-20T10:00:00Z",
}

const claimB: SupabaseOrderClaim = {
  ...claimA,
  id: 901,
  affected_items: [{ order_item_id: 72, quantity: 3 }],
  updated_at: "2026-09-20T11:00:00Z",
}

const render = (pedido: SupabasePedido, claim: SupabaseOrderClaim) =>
  act(async () =>
    root.render(
      <ReturnInventoryPanel
        canManage
        pedido={structuredClone(pedido)}
        claim={structuredClone(claim)}
        onUpdated={() => {
          updatedCalls++
        }}
      />,
    ),
  )

const article = (name: string) =>
  [...document.querySelectorAll("article")].find((element) => element.textContent?.includes(name))!
const choice = (name: string, label: string) =>
  [...article(name).querySelectorAll("button")].find((button) => button.textContent?.startsWith(label))!
const note = (name: string) => article(name).querySelector("textarea")!
const quantities = (name: string) => [...article(name).querySelectorAll<HTMLInputElement>('input[type="number"]')]
const confirmButton = (name: string) =>
  [...article(name).querySelectorAll("button")].find((button) => button.textContent === "Confirmar recepción")!
const pressed = (name: string, label: string) => choice(name, label).getAttribute("aria-pressed")

const typeText = (element: HTMLTextAreaElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
const typeNumber = (element: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
  })
const click = (element: HTMLElement) => act(async () => element.click())
const confirmDialog = async () => {
  const dialog = document.querySelector('[role="dialog"]')!
  assert.ok(dialog, "abre la confirmación")
  await click([...dialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirmar recepción"))!)
}

// Estado remoto "ya actualizado" para las pruebas de refetch.
let pedidoRemote = pedidoA
let claimRemote = claimA

test("11. refresco antes de editar: el valor del servidor se actualiza normalmente", async () => {
  await render(pedidoRemote, claimRemote)
  assert.equal(note("Auricular").value, "")
  pedidoRemote = {
    ...pedidoA,
    orden_items: [item(71, 500, 1, auricular, { return_inventory_note: "Nota del depósito" }), item(72, 500, 3, parlante)],
  }
  await render(pedidoRemote, claimRemote)
  assert.equal(note("Auricular").value, "Nota del depósito", "sin edición local, muestra lo último del servidor")
})

let textareaNode: HTMLTextAreaElement
let articleNode: HTMLElement

test("2. elegir «Volver al stock» + refetch -> sigue seleccionado", async () => {
  await click(choice("Auricular", "Volver al stock"))
  textareaNode = note("Auricular")
  articleNode = article("Auricular")
  await render(pedidoRemote, claimRemote)
  assert.equal(pressed("Auricular", "Volver al stock"), "true")
  assert.equal(pressed("Auricular", "Dar de baja"), "false")
})

test("1. elegir «Dar de baja» + refetch -> sigue seleccionado", async () => {
  await click(choice("Auricular", "Dar de baja"))
  await render(pedidoRemote, claimRemote)
  await render(pedidoRemote, claimRemote)
  assert.equal(pressed("Auricular", "Dar de baja"), "true")
  assert.equal(pressed("Auricular", "Volver al stock"), "false")
})

test("3. escribir la observación + refetch -> el texto permanece", async () => {
  await typeText(note("Auricular"), "Caja golpeada, sin accesorios")
  await render(pedidoRemote, claimRemote)
  assert.equal(note("Auricular").value, "Caja golpeada, sin accesorios")
})

test("4. cambiar cantidades + refetch -> permanecen", async () => {
  const [received, good] = quantities("Parlante")
  await typeNumber(received, "2")
  await typeNumber(good, "1")
  await render(pedidoRemote, claimRemote)
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["2", "1"])
  assert.match(article("Parlante").textContent ?? "", /Se dan de baja1/)
})

test("5. llega un update del reclamo (realtime/polling) -> el borrador permanece", async () => {
  claimRemote = {
    ...claimRemote,
    updated_at: "2026-09-20T10:05:00Z",
    admin_needs_action: false,
    order_claim_files: [],
    affected_items: claimRemote.affected_items?.map((affected) => ({ ...affected })),
  }
  await render(pedidoRemote, claimRemote)
  assert.equal(pressed("Auricular", "Dar de baja"), "true")
  assert.equal(note("Auricular").value, "Caja golpeada, sin accesorios")
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["2", "1"])
})

test("6. llegan mensajes nuevos del cliente -> el borrador permanece", async () => {
  claimRemote = {
    ...claimRemote,
    updated_at: "2026-09-20T10:06:00Z",
    order_claim_messages: [
      { id: 1, claim_id: claimRemote.id, author_role: "cliente", message: "¿Novedades del cambio?", created_at: "2026-09-20T10:06:00Z" },
    ],
  }
  await render(pedidoRemote, claimRemote)
  assert.equal(pressed("Auricular", "Dar de baja"), "true")
  assert.equal(note("Auricular").value, "Caja golpeada, sin accesorios")
})

test("7. cambia el stock remoto -> no pisa la selección y el impacto usa el stock nuevo", async () => {
  pedidoRemote = {
    ...pedidoRemote,
    orden_items: [
      item(71, 500, 1, producto(1, "Auricular Ñandú", 9), { return_inventory_note: "Nota del depósito" }),
      item(72, 500, 3, producto(2, "Parlante Güemes", 12)),
    ],
  }
  await render(pedidoRemote, claimRemote)
  assert.equal(pressed("Auricular", "Dar de baja"), "true")
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["2", "1"])
  await click(choice("Auricular", "Volver al stock"))
  assert.match(article("Auricular").textContent ?? "", /Stock: 9 → 10/)
  await click(choice("Auricular", "Dar de baja"))
})

test("12. los refrescos no desmontan el formulario (mismos nodos del DOM)", async () => {
  await render(pedidoRemote, claimRemote)
  assert.equal(note("Auricular"), textareaNode, "el textarea es el mismo nodo")
  assert.equal(article("Auricular"), articleNode, "la card es el mismo nodo")
})

test("9. confirmación fallida -> se conserva todo el borrador", async () => {
  receptionReplies.push({ ok: false })
  await click(confirmButton("Auricular"))
  await confirmDialog()
  assert.match(document.body.textContent ?? "", /No se pudo registrar la recepción/)
  assert.equal(pressed("Auricular", "Dar de baja"), "true")
  assert.equal(note("Auricular").value, "Caja golpeada, sin accesorios")
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["2", "1"])
  assert.equal(receptionBodies.at(-1)?.writtenOffQuantity, 1)
})

test("8. confirmación exitosa -> se limpia sólo el borrador de ese ítem", async () => {
  receptionReplies.push({ ok: true })
  const callsBefore = updatedCalls
  await click(confirmButton("Auricular"))
  await confirmDialog()
  assert.equal(updatedCalls, callsBefore + 1, "pide recargar los datos")
  assert.equal(pressed("Auricular", "Dar de baja"), "false", "el ítem confirmado vuelve a lo que informa el servidor")
  assert.equal(note("Auricular").value, "Nota del depósito")
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["2", "1"], "el otro ítem conserva su borrador")
  // El servidor ya registró la baja: el ítem pasa a "recepción completa".
  pedidoRemote = {
    ...pedidoRemote,
    orden_items: [
      item(71, 500, 1, producto(1, "Auricular Ñandú", 9), {
        return_written_off_quantity: 1,
        return_inventory_processed_at: "2026-09-20T10:10:00Z",
      }),
      item(72, 500, 3, producto(2, "Parlante Güemes", 12)),
    ],
  }
  await render(pedidoRemote, claimRemote)
  assert.match(article("Auricular").textContent ?? "", /Recepción completa · Dada de baja/)
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["2", "1"])
})

test("10. cambiar de reclamo o de pedido -> no mezcla borradores", async () => {
  await render(pedidoRemote, claimB)
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["0", "0"], "otro reclamo del mismo pedido arranca limpio")
  await typeNumber(quantities("Parlante")[0], "3")
  await render(pedidoRemote, claimRemote)
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["0", "0"], "volver no arrastra el borrador del otro reclamo")

  const pedidoB: SupabasePedido = {
    ...pedidoA,
    id: 501,
    orden_items: [item(81, 501, 3, parlante)],
  }
  await render(pedidoB, { ...claimA, id: 902, order_id: 501, affected_items: [{ order_item_id: 81, quantity: 3 }] })
  assert.deepEqual(quantities("Parlante").map((input) => input.value), ["0", "0"])
})

test("10b. una respuesta que llega después de cambiar de reclamo no toca el nuevo borrador", async () => {
  await render(pedidoRemote, claimRemote)
  await typeNumber(quantities("Parlante")[0], "1")
  await typeNumber(quantities("Parlante")[1], "1")
  let release!: () => void
  receptionReplies.push({ ok: true, gate: new Promise<void>((resolve) => { release = resolve }) })
  await click(confirmButton("Parlante"))
  await confirmDialog()
  // Mientras el request está en vuelo, el operador cambia de reclamo y edita.
  await render(pedidoRemote, claimB)
  await typeNumber(quantities("Parlante")[0], "2")
  await act(async () => { release() })
  assert.equal(quantities("Parlante")[0].value, "2")
  assert.doesNotMatch(document.body.textContent ?? "", /Recepción guardada/)
})
