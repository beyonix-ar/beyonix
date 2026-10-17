import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act, useState } from "react"

import type { DispatchScanMethod } from "./dispatch"

test("ScanField acepta teclado, pegado y lector con foco estable durante esperas y errores", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import("react-dom/client")
  const { ScanField } = await import("../../app/admin/sections/despachos/scan-field")
  const root = createRoot(dom.window.document.getElementById("root")!)
  const reads: Array<{ code: string; method: DispatchScanMethod }> = []

  function Field({ busy = false }: { busy?: boolean }) {
    const [value, setValue] = useState("")
    const [error, setError] = useState("")
    return <ScanField label="Escanear producto" placeholder="Escaneá el producto" submitLabel="Verificar"
      value={value} onChange={setValue} busy={busy} autoFocus cameraTitle="Producto" cameraHint="Código"
      feedback={error ? { tone: "error", message: error } : null}
      onScan={(code, method) => {
        reads.push({ code, method })
        setValue("")
        setError(code === "ERROR" ? "Código incorrecto" : "")
      }} />
  }

  const input = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear producto"]')!
  const form = () => input().closest("form")!
  const write = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input(), value); input().dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
  }
  const send = async () => {
    await act(async () => { form().dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
  }

  try {
    await act(async () => { root.render(<Field />) })
    assert.equal(input().type, "text")
    assert.equal(input().readOnly, false)
    assert.equal(input().disabled, false)
    assert.equal(dom.window.document.activeElement, input(), "foco al entrar")

    await write("7170972998100")
    await act(async () => { input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    await send()
    assert.deepEqual(reads.at(-1), { code: "7170972998100", method: "manual_code" })
    assert.equal(input().value, "")
    assert.equal(dom.window.document.activeElement, input(), "foco tras Enter")

    await write("  BX-1006  ")
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click() })
    assert.deepEqual(reads.at(-1), { code: "BX-1006", method: "manual_code" })
    assert.equal(dom.window.document.activeElement, input(), "foco tras botón")

    await act(async () => { input().dispatchEvent(new dom.window.Event("paste", { bubbles: true })) })
    await write("DSP-20261016-001")
    await send()
    assert.deepEqual(reads.at(-1), { code: "DSP-20261016-001", method: "manual_code" })

    await write("7170972998100")
    await act(async () => { for (const key of "7170972998100") input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })) })
    await send()
    assert.deepEqual(reads.at(-1), { code: "7170972998100", method: "scanner" })

    await write("ERROR")
    await send()
    assert.equal(dom.window.document.activeElement, input(), "foco tras error")
    assert.equal(input().value, "")

    await act(async () => { root.render(<Field busy />) })
    assert.equal(input().disabled, false, "espera temporal no deshabilita el texto")
    assert.equal(input().readOnly, false)
    await write("CODIGO-EN-ESPERA")
    assert.equal(input().value, "CODIGO-EN-ESPERA")
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true)
    await act(async () => { root.render(<Field />) })
    assert.equal(dom.window.document.activeElement, input(), "recupera foco al terminar la espera")
  } finally {
    await act(async () => { root.unmount() })
    dom.window.close()
  }
})
