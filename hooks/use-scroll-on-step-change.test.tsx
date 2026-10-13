import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { JSDOM } from "jsdom"
import { act, useRef } from "react"
import { createRoot } from "react-dom/client"
import { useScrollOnStepChange } from "./use-scroll-on-step-change"

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })

const scrolls: Array<{ target: string | null; options: ScrollIntoViewOptions }> = []
HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) {
  scrolls.push({ target: this.getAttribute("data-target"), options: options ?? {} })
}
let reducedMotion = false
window.matchMedia = () => ({ matches: reducedMotion }) as MediaQueryList
let frame = 0
const frames = new Map<number, FrameRequestCallback>()
globalThis.requestAnimationFrame = (callback) => { frames.set(++frame, callback); return frame }
globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
const flush = () => { for (const callback of frames.values()) callback(0); frames.clear() }

function Harness({ step, revision }: { step: number; revision: number }) {
  const topRef = useRef<HTMLDivElement>(null)
  useScrollOnStepChange(step, topRef)
  return <div ref={topRef} data-target="checkout-top" data-revision={revision}>Checkout</div>
}

test("cambio real de paso (avanzar y volver) desplaza al inicio del checkout; mismo paso no", async () => {
  const root = createRoot(document.getElementById("root")!)
  const render = async (step: number, revision = 0) => {
    await act(async () => { root.render(<Harness step={step} revision={revision} />) })
    flush()
  }

  await render(1)
  assert.equal(scrolls.length, 0, "sin desplazamiento al montar")

  await render(2)
  assert.deepEqual(scrolls.at(-1), { target: "checkout-top", options: { behavior: "smooth", block: "start" } }, "Paso 1 → 2")
  await render(3)
  assert.equal(scrolls.length, 2, "Paso 2 → 3")
  await render(3, 1)
  await render(3, 2)
  assert.equal(scrolls.length, 2, "refetch/re-render dentro del Paso 3 no desplaza")
  await render(2)
  assert.equal(scrolls.length, 3, "Paso 3 → 2 (Anterior)")
  await render(1)
  assert.equal(scrolls.length, 4, "Paso 2 → 1 (Anterior)")
  await render(1, 3)
  assert.equal(scrolls.length, 4, "refetch dentro del Paso 1 no desplaza")

  reducedMotion = true
  await render(2)
  assert.deepEqual(scrolls.at(-1)?.options, { behavior: "auto", block: "start" }, "respeta prefers-reduced-motion")
  reducedMotion = false

  await act(async () => { root.unmount() })
})

test("dos cambios en el mismo frame producen un solo desplazamiento (sin doble salto)", async () => {
  const root = createRoot(document.getElementById("root")!)
  await act(async () => { root.render(<Harness step={1} revision={0} />) })
  const before = scrolls.length
  await act(async () => { root.render(<Harness step={2} revision={0} />) })
  await act(async () => { root.render(<Harness step={3} revision={0} />) })
  flush()
  assert.equal(scrolls.length, before + 1)
  await act(async () => { root.unmount() })
})

test("checkout: el destino es el bloque superior (Compra segura / Checkout / pasos) con offset del header sticky", () => {
  const source = readFileSync("app/checkout/page.tsx", "utf8")
  assert.match(source, /useScrollOnStepChange\(currentStep, checkoutTopRef\)/)
  const anchor = source.indexOf("ref={checkoutTopRef}")
  assert.ok(anchor > 0)
  const block = source.slice(anchor, source.indexOf("checkout-progress", anchor))
  assert.match(block, /scroll-mt-20/)
  assert.match(block, /lg:scroll-mt-24/)
  assert.match(block, /Compra segura/)
  assert.match(block, /Checkout/)
})
