import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright-core"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"

test("picking: input controlado permite teclado y Enter en un navegador real", async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { useState } from "react"
        import { createRoot } from "react-dom/client"
        import { ScanField } from "./app/admin/sections/despachos/scan-field"
        window.__scanCalls = []
        function Picking() {
          const [code, setCode] = useState("")
          return <ScanField label="Escanear o ingresar código / SKU" placeholder="Escaneá el producto" submitLabel="Verificar"
            value={code} onChange={setCode} onScan={(value) => { window.__scanCalls.push(value); setCode("") }}
            autoFocus cameraTitle="Pickeo" cameraHint="Producto" />
        }
        createRoot(document.getElementById("root")).render(<Picking />)
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": process.cwd() },
    define: { "process.env.NODE_ENV": '"test"' },
  })
  const css = (await postcss([tailwindcss({ base: process.cwd() })]).process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<html data-admin-theme="dark"><head><style>${css}</style></head><body><main class="beyonix-admin-main"><div id="root"></div></main></body></html>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const input = page.getByRole("textbox", { name: "Escanear o ingresar código / SKU" })
    await input.waitFor()
    assert.equal(await input.getAttribute("type"), "text")
    assert.equal(await input.isEnabled(), true)
    assert.equal(await input.evaluate((el) => document.elementFromPoint(el.getBoundingClientRect().left + 20, el.getBoundingClientRect().top + 20) === el), true, "el input recibe clics; no hay overlay")
    await input.click()
    await input.pressSequentially("7170972998100")
    assert.equal(await input.inputValue(), "7170972998100")
    await input.press("Enter")
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __scanCalls: string[] }).__scanCalls), ["7170972998100"])
    assert.equal(await input.inputValue(), "")
  } finally { await browser.close() }
})
