import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import bwipjs from "bwip-js/node"
import { RGBLuminanceSource } from "@zxing/library"

import { createBarcodeReader, type BarcodeReader } from "../../lib/admin/barcode-reader"
import { createZxingDecoder } from "../../lib/admin/zxing-barcode-reader"

// Escaneo con cámara de Despachos, una sola arquitectura:
//   lector USB / cámara Android (BarcodeDetector) / cámara iPhone (ZXing)
//   → mismo anti-relectura → mismo onDetected (el handler de escaneo).

async function setup() {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 })
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", { configurable: true, value: async () => {} })
  const { createRoot } = await import("react-dom/client")
  return { dom, root: createRoot(dom.window.document.getElementById("root")!) }
}

const settle = async (ms = 60) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }

type Camera = { stopped: number; constraints?: MediaStreamConstraints }
function camera(behavior: "ok" | Error | null): Camera {
  const state: Camera = { stopped: 0 }
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: behavior === null ? {} : {
    mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
      state.constraints = constraints
      if (behavior instanceof Error) throw behavior
      return { getTracks: () => [{ stop: () => { state.stopped += 1 } }] }
    } },
  } })
  return state
}

/** Lector simulado: devuelve un cuadro por llamada (null = cuadro sin código). */
function frames(kind: BarcodeReader["kind"], sequence: Array<string | null>): BarcodeReader {
  return { kind, detect: async () => sequence.length ? sequence.shift() ?? null : null }
}

async function manual(dom: JSDOM, value: string) {
  const input = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Ingresar código a mano"]')!
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
  await act(async () => { input.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
}

// ── Selección del motor ────────────────────────────────────────────────────
test("motor: Android con BarcodeDetector usa el nativo; sin él (Chrome viejo o Safari/iPhone) carga ZXing", async () => {
  class NativeDetector { static async getSupportedFormats() { return ["code_128", "ean_13", "qr_code"] } async detect() { return [{ rawValue: "BX-PKG-1006-01" }] } }
  let fallbackLoads = 0
  const fallback = async () => { fallbackLoads += 1; return frames("fallback", ["BX-PREP-1006"]) }
  const android = await createBarcodeReader({ BarcodeDetector: NativeDetector }, fallback)
  assert.equal(android.kind, "native")
  assert.equal(fallbackLoads, 0, "Android no descarga ZXing")
  const safari = await createBarcodeReader({}, fallback)
  assert.equal(safari.kind, "fallback")
  class LinearlessDetector { static async getSupportedFormats() { return ["qr_code"] } async detect() { return [] } }
  assert.equal((await createBarcodeReader({ BarcodeDetector: LinearlessDetector }, fallback)).kind, "fallback", "API sin Code 128: también ZXing")
  assert.equal(fallbackLoads, 2)
})

test("ZXing decodifica de verdad nuestras etiquetas Code 128 y un EAN-13 de fabricante", () => {
  const decode = createZxingDecoder()
  const image = (bcid: string, text: string) => {
    const [{ sbs }] = bwipjs.raw({ bcid, text }) as Array<{ sbs: number[] }>
    const quiet = 12, scale = 3, height = 40
    const modules = sbs.reduce((sum, width) => sum + width, 0) + quiet * 2
    const row: number[] = new Array<number>(quiet).fill(255)
    sbs.forEach((width, index) => { for (let i = 0; i < width; i += 1) row.push(index % 2 === 0 ? 0 : 255) })
    row.push(...new Array<number>(quiet).fill(255))
    const width = modules * scale
    const pixels = new Uint8ClampedArray(width * height)
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) pixels[y * width + x] = row[Math.floor(x / scale)]
    return new RGBLuminanceSource(pixels, width, height)
  }
  for (const code of ["BX-PKG-1006-01", "BX-PREP-1006-R2", "DSP-20261016-001", "BX-AUR-000123"]) {
    assert.equal(decode(image("code128", code)), code)
  }
  assert.equal(decode(image("ean13", "779000000004")), "7790000000041")
  assert.equal(decode(new RGBLuminanceSource(new Uint8ClampedArray(300 * 40).fill(255), 300, 40)), null, "cuadro sin código")
})

// ── Cámara ────────────────────────────────────────────────────────────────
for (const [name, kind] of [["Android con BarcodeDetector", "native"], ["iPhone/Safari sin BarcodeDetector (ZXing)", "fallback"]] as const) {
  test(`${name}: cámara trasera, lectura continua, sin doble lectura y cámara liberada al cerrar`, async () => {
    const { dom, root } = await setup()
    const { CameraScanner } = await import("../../app/admin/sections/despachos/camera-scanner")
    const cam = camera("ok")
    const detected: string[] = []
    // Mismo código quieto en cuadro 3 veces, sale de cuadro, vuelve: 2 lecturas.
    const reader = frames(kind, ["BX-PKG-1006-01", "BX-PKG-1006-01", "bx-pkg-1006-01", null, null, null, "BX-PKG-1006-01", "BX-PKG-1006-02"])
    try {
      await act(async () => { root.render(<CameraScanner open continuous title="Lote" hint="Encuadrá la etiqueta" createReader={async () => reader} onDetected={(code) => detected.push(code)} onClose={() => {}} />) })
      await settle(kind === "native" ? 1300 : 2000)
      assert.deepEqual(detected, ["BX-PKG-1006-01", "BX-PKG-1006-01", "BX-PKG-1006-02"])
      assert.deepEqual(cam.constraints, { video: { facingMode: { ideal: "environment" } }, audio: false }, "cámara trasera")
      assert.equal(dom.window.document.querySelector("[data-reader]")?.getAttribute("data-reader"), kind)
      await act(async () => { root.render(<CameraScanner open={false} title="Lote" hint="" onDetected={() => {}} onClose={() => {}} />) })
      assert.equal(cam.stopped, 1)
    } finally { await act(async () => root.unmount()); dom.window.close() }
  })
}

test("lectura única (retiro/entrega): toma un código y deja de leer", async () => {
  const { dom, root } = await setup()
  const { CameraScanner } = await import("../../app/admin/sections/despachos/camera-scanner")
  camera("ok")
  const detected: string[] = []
  try {
    await act(async () => { root.render(<CameraScanner open title="Retirar" hint="" createReader={async () => frames("fallback", ["BX-PREP-1006", "BX-PREP-1007"])} onDetected={(code) => detected.push(code)} onClose={() => {}} />) })
    await settle(900)
    assert.deepEqual(detected, ["BX-PREP-1006"])
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

const failures = [
  ["permiso denegado (Safari o Android)", new DOMException("denied", "NotAllowedError"), /No diste permiso para usar la cámara/, "denied"],
  ["cámara inexistente", new DOMException("none", "NotFoundError"), /No se encontró una cámara disponible/, "unavailable"],
  ["cámara ocupada por otra app", new DOMException("busy", "NotReadableError"), /La cámara está en uso por otra app/, "busy"],
  ["navegador sin acceso a cámara", null, /Este navegador no permite usar la cámara/, "unsupported"],
] as const
for (const [name, error, message, state] of failures) {
  test(`${name}: mensaje claro e ingreso manual por el mismo flujo`, async () => {
    const { dom, root } = await setup()
    const { CameraScanner } = await import("../../app/admin/sections/despachos/camera-scanner")
    camera(error)
    let readerRequested = false
    const detected: string[] = []
    try {
      await act(async () => { root.render(<CameraScanner open title="Armado BX-1006" hint="" createReader={async () => { readerRequested = true; return frames("native", []) }} onDetected={(code) => detected.push(code)} onClose={() => {}} />) })
      await settle()
      assert.match(dom.window.document.body.textContent ?? "", message)
      assert.equal(dom.window.document.querySelector("[data-camera-state]")?.getAttribute("data-camera-state"), state)
      assert.equal(readerRequested, false, "sin cámara no se carga ningún motor")
      await manual(dom, "  7790000000041 ")
      assert.deepEqual(detected, ["7790000000041"])
    } finally { await act(async () => root.unmount()); dom.window.close() }
  })
}
