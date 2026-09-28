import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement, Fragment } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { chromium, type Browser } from "playwright-core"
import { ToggleLeft, ToggleRight } from "lucide-react"

import { AdminSecondaryButton } from "@/app/admin/components/admin-controls"

// Toggles de habilitar/deshabilitar del Admin (patrón único .admin-toggle):
// botón real + CSS compilado del proyecto, medido en Edge/Chrome. En
// Financiación, 4 toggles compactos entran en UNA fila con el ancho mínimo
// real de la tarjeta en desktop (lugar para un botón a la derecha de "6
// cuotas"); habilitado = verde oscuro, deshabilitado = neutro; texto legible,
// foco visible y área clickeable >= 40px en Light y Dark.

let browser: Browser
let css: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })])
    .process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

// Mismo markup que producto-form.tsx (Financiación).
function financingToggle(label: string, active: boolean, detail: string) {
  return createElement(
    AdminSecondaryButton,
    {
      "aria-pressed": active,
      "aria-label": `${label}: ${active ? "habilitado" : "deshabilitado"}`,
      className: `admin-toggle product-editor-financing-toggle grid min-h-11 grid-cols-[auto_minmax(0,1fr)] content-center items-center gap-x-1.5 gap-y-0.5 px-2 py-1 text-left ${active ? "admin-toggle-on" : ""}`,
    },
    createElement(active ? ToggleRight : ToggleLeft, { "aria-hidden": "true", className: "admin-toggle-icon size-4 shrink-0" }),
    createElement("span", { className: "text-xs font-black leading-4 text-white" }, label),
    createElement("span", { className: "admin-toggle-detail col-span-2 whitespace-nowrap text-10px font-semibold leading-4 text-white/70" }, detail),
  )
}

const financingCard = renderToStaticMarkup(
  createElement(
    Fragment,
    null,
    createElement(
      "div",
      { className: "product-editor-financing-grid gap-1.5" },
      financingToggle("2 cuotas", true, "$ 123.456 c/u"),
      financingToggle("3 cuotas", false, "Deshabilitado"),
      financingToggle("6 cuotas", true, "$ 41.152 c/u"),
      // Futuro botón a la derecha de "6 cuotas": mismo tamaño.
      financingToggle("12 cuotas", false, "Deshabilitado"),
    ),
  ),
)

type ToggleMeasure = {
  pressed: string | null
  top: number
  right: number
  height: number
  background: [number, number, number]
  textContrast: number
  detailContrast: number
  iconColor: string
}

// ~26.8rem útiles en el umbral de 3 columnas (76rem, ver
// .product-editor-row-top); se mide con 26.5rem para dejar margen.
const CARD_INNER_WIDTH_REM = 26.5

async function render(theme: "light" | "dark") {
  const page = await browser.newPage()
  try {
    await page.route("**/*", (route) => route.abort())
    await page.setContent(`<!doctype html>
<html data-admin-theme="${theme}"><head><style>${css}</style></head>
<body style="margin:0;background:${theme === "light" ? "#ffffff" : "#07111b"}">
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div class="product-editor-screen">
<div id="card" style="width:${CARD_INNER_WIDTH_REM}rem;padding:0;background:${theme === "light" ? "#ffffff" : "#07111b"}">${financingCard}</div>
</div></main></div></body></html>`)
    const toggles = (await page.evaluate(`(() => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 1
      const context = canvas.getContext("2d", { willReadFrequently: true })
      const rgba = (value) => {
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
        return [r, g, b, a / 255]
      }
      const channel = (value) => {
        const scaled = value / 255
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
      }
      const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
      const over = (top, bottom) => top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3]))
      const contrast = (x, y) => {
        const [a, b] = [luminance(x), luminance(y)].sort((l, r) => r - l)
        return (a + 0.05) / (b + 0.05)
      }
      const card = document.getElementById("card")
      const panel = rgba(getComputedStyle(card).backgroundColor)
      const cardLeft = card.getBoundingClientRect().left
      return [...document.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect()
        const background = over(rgba(getComputedStyle(button).backgroundColor), panel)
        const [label, detail] = button.querySelectorAll("span")
        return {
          pressed: button.getAttribute("aria-pressed"),
          top: Math.round(box.top),
          right: box.right - cardLeft,
          height: box.height,
          background: background.map(Math.round),
          textContrast: contrast(over(rgba(getComputedStyle(label).color), background), background),
          detailContrast: contrast(over(rgba(getComputedStyle(detail).color), background), background),
          iconColor: getComputedStyle(button.querySelector("svg")).color,
        }
      })
    })()`)) as ToggleMeasure[]

    await page.keyboard.press("Tab")
    const focus = (await page.evaluate(`(() => {
      const style = getComputedStyle(document.activeElement)
      return { tag: document.activeElement.tagName, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
    })()`)) as { tag: string; outlineStyle: string; outlineWidth: string }

    return { toggles, focus, cardWidth: CARD_INNER_WIDTH_REM * 16 }
  } finally {
    await page.close()
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: 4 toggles compactos en una fila, verde oscuro habilitado, neutro deshabilitado, legibles y con foco`, async () => {
    const { toggles, focus, cardWidth } = await render(theme)
    assert.equal(toggles.length, 4)

    // Una sola fila y sin desbordar la tarjeta: entra un 4to botón.
    assert.equal(new Set(toggles.map((toggle) => toggle.top)).size, 1, "los 4 en la misma fila")
    assert.ok(Math.max(...toggles.map((toggle) => toggle.right)) <= cardWidth, "no desborda la tarjeta")
    for (const toggle of toggles) assert.ok(toggle.height >= 40, `área clickeable (${toggle.height}px)`)

    const on = toggles.filter((toggle) => toggle.pressed === "true")
    const off = toggles.filter((toggle) => toggle.pressed === "false")
    for (const toggle of on) {
      const [r, g, b] = toggle.background
      assert.ok(g > r && g > b && g <= 110, `habilitado = verde oscuro (rgb ${toggle.background.join(",")})`)
      assert.ok(toggle.textContrast >= 7, `texto habilitado (${toggle.textContrast.toFixed(2)}:1)`)
      assert.ok(toggle.detailContrast >= 4.5, `detalle habilitado (${toggle.detailContrast.toFixed(2)}:1)`)
    }
    for (const toggle of off) {
      const [r, g, b] = toggle.background
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 20, `deshabilitado = neutro (rgb ${toggle.background.join(",")})`)
      assert.ok(toggle.textContrast >= 7, `texto deshabilitado (${toggle.textContrast.toFixed(2)}:1)`)
      assert.ok(toggle.detailContrast >= 4.5, `detalle deshabilitado (${toggle.detailContrast.toFixed(2)}:1)`)
    }
    assert.notEqual(on[0].iconColor, off[0].iconColor, "el ícono también distingue el estado")

    assert.equal(focus.tag, "BUTTON")
    assert.equal(focus.outlineStyle, "solid", "foco de teclado visible")
    assert.equal(focus.outlineWidth, "2px")
  })
}

test("todos los toggles on/off del editor usan el patrón único (sin estilos emerald sueltos)", () => {
  const read = (path: string) => readFileSync(path, "utf8")
  const form = read("app/admin/sections/productos/producto-form.tsx")
  const specs = read("app/admin/sections/productos/product-specifications-editor.tsx")
  const conditioned = read("app/admin/sections/productos/productos-row.tsx")
  assert.equal(form.match(/admin-toggle product-editor-financing-toggle/g)?.length, 2, "cuotas + mismo precio")
  assert.match(form, /admin-toggle inline-flex min-w-12/, "Estado / Destacado")
  assert.equal(specs.match(/className=\{`admin-toggle /g)?.length, 2, "especificación: botón y acción")
  assert.match(conditioned, /admin-toggle flex w-full/, "stock condicionado")
  assert.match(conditioned, /admin-toggle-track/)
  for (const source of [form, specs]) {
    assert.doesNotMatch(source, /product-editor-toggle-active|product-editor-spec-toggle-active|product-editor-spec-action-active/)
  }
})
