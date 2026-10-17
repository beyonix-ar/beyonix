import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act, useState } from "react"
import userEvent from "@testing-library/user-event"

import type { DispatchScanMethod } from "./dispatch"

test("ScanField acepta teclado, pegado y lector con foco estable durante esperas y errores", async () => {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import("react-dom/client")
  const { ScanField } = await import("../../app/admin/sections/despachos/scan-field")
  const root = createRoot(dom.window.document.getElementById("root")!)
  const user = userEvent.setup({ document: dom.window.document })
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
  try {
    await act(async () => { root.render(<Field />) })
    assert.equal(input().type, "text")
    assert.equal(input().readOnly, false)
    assert.equal(input().disabled, false)
    assert.equal(dom.window.document.activeElement, input(), "foco al entrar")

    await act(async () => { await user.type(input(), "7170972998100") })
    assert.equal(input().value, "7170972998100", "cada tecla actualiza el input controlado")
    await act(async () => { await user.keyboard("{Enter}") })
    assert.equal(reads.length, 1, "Enter procesa una sola vez")
    assert.equal(reads.at(-1)?.code, "7170972998100")
    assert.equal(input().value, "")
    assert.equal(dom.window.document.activeElement, input(), "foco tras Enter")

    await act(async () => { await user.type(input(), "BX-1006") })
    assert.equal(input().value, "BX-1006")
    await act(async () => { await user.click(dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!) })
    assert.equal(reads.at(-1)?.code, "BX-1006")
    assert.equal(dom.window.document.activeElement, input(), "foco tras botón")

    await act(async () => { await user.type(input(), "ABCD{Backspace}") })
    assert.equal(input().value, "ABC", "Backspace edita el texto")
    await act(async () => { await user.keyboard("{Control>}a{/Control}"); await user.keyboard("{Delete}") })
    assert.equal(input().value, "", "Ctrl+A y Delete funcionan")

    await act(async () => { await user.click(input()); await user.paste("DSP-20261016-001") })
    assert.equal(input().value, "DSP-20261016-001")
    await act(async () => { await user.keyboard("{Enter}") })
    assert.deepEqual(reads.at(-1), { code: "DSP-20261016-001", method: "manual_code" })

    await act(async () => { await user.keyboard("7170972998100{Enter}") })
    assert.deepEqual(reads.at(-1), { code: "7170972998100", method: "scanner" })

    await act(async () => { await user.type(input(), "ERROR{Enter}") })
    assert.equal(dom.window.document.activeElement, input(), "foco tras error")
    assert.equal(input().value, "")

    await act(async () => { root.render(<Field busy />) })
    assert.equal(input().disabled, false, "espera temporal no deshabilita el texto")
    assert.equal(input().readOnly, false)
    await act(async () => { await user.type(input(), "CODIGO-EN-ESPERA") })
    assert.equal(input().value, "CODIGO-EN-ESPERA")
    assert.equal(dom.window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true)
    await act(async () => { root.render(<Field />) })
    assert.equal(dom.window.document.activeElement, input(), "recupera foco al terminar la espera")
  } finally {
    await act(async () => { root.unmount() })
    dom.window.close()
  }
})
