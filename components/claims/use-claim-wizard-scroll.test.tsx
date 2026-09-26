import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act, useRef } from "react"
import { createRoot } from "react-dom/client"
import { useClaimWizardScroll } from "./use-claim-wizard-scroll"

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })

const scrolls: ScrollIntoViewOptions[] = []
HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) { scrolls.push(options ?? {}) }
window.matchMedia = () => ({ matches: false }) as MediaQueryList
let frame = 0
const frames = new Map<number, FrameRequestCallback>()
globalThis.requestAnimationFrame = (callback) => { frames.set(++frame, callback); return frame }
globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
const flush = () => { for (const callback of frames.values()) callback(0); frames.clear() }

function Harness({ claimId, step }: { claimId: number; step: string }) {
  const headerRef = useRef<HTMLElement>(null)
  useClaimWizardScroll(claimId, step, true, headerRef)
  return <header ref={headerRef}>Reclamo</header>
}

test("avanzar y volver desplaza al encabezado; un refresh del mismo paso no", async () => {
  const root = createRoot(document.getElementById("root")!)
  const render = async (claimId: number, step: string) => {
    await act(async () => { root.render(<Harness claimId={claimId} step={step} />) })
    flush()
  }
  await render(1, "review")
  assert.equal(scrolls.length, 0, "sin desplazamiento al montar")
  await render(1, "reception")
  assert.deepEqual(scrolls.at(-1), { behavior: "smooth", block: "start" })
  await render(1, "reception")
  assert.equal(scrolls.length, 1, "polling sin cambio de paso")
  await render(1, "review")
  assert.equal(scrolls.length, 2, "volver al paso anterior")
  await render(2, "review")
  assert.equal(scrolls.length, 2, "cambiar de reclamo no desplaza")
  await act(async () => { root.unmount() })
})
