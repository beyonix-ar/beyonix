import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { chromium, type Browser } from "playwright-core"
import { ToggleLeft, ToggleRight } from "lucide-react"

import { AdminSecondaryButton } from "@/app/admin/components/admin-controls"

// Toggles de habilitar/deshabilitar del Admin (patrón único .admin-toggle):
// botón real + CSS compilado del proyecto, medido en Edge/Chrome dentro de la
// fila superior REAL del editor (.product-editor-workspace > .product-editor-
// row-top: Información | Precio 25.5rem | Financiación). En desktop los 4
// controles de Financiación van en UNA fila, mismo alto y sin desbordar;
// habilitado = verde oscuro, deshabilitado = neutro; legibles y con foco.

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

const toggleIcon = (active: boolean) =>
  createElement(active ? ToggleRight : ToggleLeft, { "aria-hidden": "true", className: "admin-toggle-icon size-4 shrink-0" })

// Mismo markup que producto-form.tsx (Financiación).
function installmentToggle(label: string, active: boolean, detail: string) {
  return createElement(
    AdminSecondaryButton,
    {
      "aria-pressed": active,
      "aria-label": `${label}: ${active ? "habilitado" : "deshabilitado"}`,
      className: `admin-toggle product-editor-financing-toggle grid min-h-11 grid-cols-[auto_minmax(0,1fr)] content-center items-center gap-x-1 gap-y-0.5 px-1.5 py-1 text-left ${active ? "admin-toggle-on" : ""}`,
    },
    toggleIcon(active),
    createElement("span", { className: "whitespace-nowrap text-xs font-black leading-4 text-white" }, label),
    createElement("span", { className: "admin-toggle-detail col-span-2 whitespace-nowrap text-10px font-semibold leading-4 text-white/70" }, detail),
  )
}

function samePriceToggle(active: boolean) {
  return createElement(
    AdminSecondaryButton,
    {
      "aria-pressed": active,
      "aria-label": `Mismo precio en contado y cuotas: ${active ? "activado" : "desactivado"}`,
      className: `admin-toggle product-editor-financing-toggle product-editor-financing-toggle-wide grid min-h-11 grid-cols-[auto_minmax(0,1fr)] content-center items-center gap-x-1 px-1.5 py-1 text-left ${active ? "admin-toggle-on" : ""}`,
    },
    toggleIcon(active),
    createElement("span", { className: "text-xs font-black leading-4 text-white" }, "Mismo precio en contado y cuotas"),
  )
}

// Montos largos a propósito (peor caso de ancho de las cuotas).
const financingCard = renderToStaticMarkup(
  createElement(
    "div",
    { id: "card", className: "product-editor-panel flex min-w-0 flex-col space-y-2 p-2.5" },
    createElement("h2", { className: "text-base font-black text-white" }, "Financiación"),
    createElement(
      "div",
      { className: "product-editor-financing-grid gap-1.5" },
      installmentToggle("2 cuotas", true, "$ 123.456 c/u"),
      installmentToggle("3 cuotas", false, "Deshabilitado"),
      installmentToggle("6 cuotas", true, "$ 41.152 c/u"),
      samePriceToggle(true),
    ),
  ),
)

type ToggleMeasure = {
  pressed: string | null
  top: number
  left: number
  right: number
  height: number
  labelFontSize: number
  labelLines: number
  background: [number, number, number]
  textContrast: number
  detailContrast: number | null
  iconColor: string
}

type Layout = { rootFontSize: number; cardLeft: number; cardRight: number; toggles: ToggleMeasure[] }

// workspaceRem: ancho real del área de trabajo del editor. 76rem es el umbral
// de 3 columnas (tarjeta más angosta en desktop); 60rem = 1 columna.
async function render(theme: "light" | "dark", workspaceRem: number) {
  const page = await browser.newPage({ viewport: { width: Math.ceil(workspaceRem * 16) + 40, height: 600 } })
  try {
    await page.route("**/*", (route) => route.abort())
    const background = theme === "light" ? "#ffffff" : "#07111b"
    await page.setContent(`<!doctype html>
<html data-admin-theme="${theme}"><head><style>${css}</style></head>
<body style="margin:0;background:${background}">
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div class="product-editor-screen">
<div class="product-editor-workspace min-w-0 gap-2.5" style="width:${workspaceRem}rem">
<div class="product-editor-row-top grid min-w-0 gap-2.5 items-start">
<div class="product-editor-cell"><div class="p-2.5">Información del producto</div></div>
<div class="product-editor-cell"><div class="p-2.5">Precio</div></div>
<div class="product-editor-cell" style="background:${background}">${financingCard}</div>
</div></div></div></main></div></body></html>`)
    const layout = (await page.evaluate(`(() => {
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
      const cardBox = card.getBoundingClientRect()
      const cardStyle = getComputedStyle(card)
      const panel = rgba(getComputedStyle(card.parentElement).backgroundColor)
      return {
        rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        cardLeft: cardBox.left + parseFloat(cardStyle.paddingLeft),
        cardRight: cardBox.right - parseFloat(cardStyle.paddingRight),
        toggles: [...card.querySelectorAll("button")].map((button) => {
          const box = button.getBoundingClientRect()
          const background = over(rgba(getComputedStyle(button).backgroundColor), panel)
          const [label, detail] = button.querySelectorAll("span")
          const textOf = (element) => contrast(over(rgba(getComputedStyle(element).color), background), background)
          return {
            pressed: button.getAttribute("aria-pressed"),
            top: Math.round(box.top),
            left: box.left,
            right: box.right,
            height: Math.round(box.height),
            labelFontSize: parseFloat(getComputedStyle(label).fontSize),
            labelLines: Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight)),
            background: background.map(Math.round),
            textContrast: textOf(label),
            detailContrast: detail ? textOf(detail) : null,
            iconColor: getComputedStyle(button.querySelector("svg")).color,
          }
        }),
      }
    })()`)) as Layout

    await page.keyboard.press("Tab")
    const focus = (await page.evaluate(`(() => {
      const style = getComputedStyle(document.activeElement)
      return { tag: document.activeElement.tagName, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
    })()`)) as { tag: string; outlineStyle: string; outlineWidth: string }

    return { layout, focus }
  } finally {
    await page.close()
  }
}

function assertInsideCard({ cardLeft, cardRight, toggles }: Layout, label: string) {
  for (const toggle of toggles) {
    assert.ok(toggle.left >= cardLeft - 0.5 && toggle.right <= cardRight + 0.5, `${label}: no desborda la tarjeta`)
  }
}

// 76rem = umbral de 3 columnas (Financiación ~28rem, lo más angosto en
// desktop); 80/90/105rem = notebooks y monitores; 60rem = 1 columna.
for (const workspaceRem of [76, 80, 90, 105, 60]) {
  test(`desktop (workspace ${workspaceRem}rem): [2 cuotas] [3 cuotas] [6 cuotas] [Mismo precio] en UNA fila, mismo alto`, async () => {
    const { layout } = await render("dark", workspaceRem)
    const { toggles } = layout
    assert.equal(toggles.length, 4)
    assert.equal(new Set(toggles.map((toggle) => toggle.top)).size, 1, `una sola fila (tops ${toggles.map((toggle) => toggle.top).join(",")})`)
    assert.equal(new Set(toggles.map((toggle) => toggle.height)).size, 1, `mismo alto (${toggles.map((toggle) => toggle.height).join(",")})`)
    for (let index = 1; index < toggles.length; index++) {
      const gap = toggles[index].left - toggles[index - 1].right
      assert.ok(gap >= 5 && gap <= 7, `gap chico y parejo (${gap}px)`)
    }
    // La fuente raíz del Admin escala con el viewport: alto y texto se miden en rem.
    const rem = layout.rootFontSize
    for (const toggle of toggles) {
      const heightRem = toggle.height / rem
      assert.ok(heightRem >= 2.6 && heightRem <= 3.3, `compacto y clickeable (${toggle.height}px = ${heightRem.toFixed(2)}rem)`)
      assert.ok(toggle.height >= 40, `área clickeable >= 40px (${toggle.height}px)`)
      assert.ok(toggle.labelFontSize / rem >= 0.74, `texto sin achicar (${toggle.labelFontSize}px)`)
    }
    // Cuotas: nombre en 1 línea; "Mismo precio en / contado y cuotas" siempre en 2.
    assert.deepEqual(toggles.map((toggle) => toggle.labelLines), [1, 1, 1, 2])
    assertInsideCard(layout, `${workspaceRem}rem`)
  })
}

test("mobile (tarjeta angosta): pueden bajar de fila, sin desbordar", async () => {
  const { layout } = await render("dark", 20)
  assert.ok(new Set(layout.toggles.map((toggle) => toggle.top)).size > 1, "envuelven")
  assertInsideCard(layout, "mobile")
})

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: habilitado verde oscuro, deshabilitado neutro, legibles y con foco de teclado`, async () => {
    const { layout, focus } = await render(theme, 76)
    const on = layout.toggles.filter((toggle) => toggle.pressed === "true")
    const off = layout.toggles.filter((toggle) => toggle.pressed === "false")
    assert.ok(on.length >= 1 && off.length >= 1)
    for (const toggle of on) {
      const [r, g, b] = toggle.background
      assert.ok(g > r && g > b && g <= 110, `habilitado = verde oscuro (rgb ${toggle.background.join(",")})`)
      assert.ok(toggle.textContrast >= 7, `texto habilitado (${toggle.textContrast.toFixed(2)}:1)`)
      if (toggle.detailContrast != null) assert.ok(toggle.detailContrast >= 4.5, `detalle habilitado (${toggle.detailContrast.toFixed(2)}:1)`)
    }
    for (const toggle of off) {
      const [r, g, b] = toggle.background
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 20, `deshabilitado = neutro (rgb ${toggle.background.join(",")})`)
      assert.ok(toggle.textContrast >= 7, `texto deshabilitado (${toggle.textContrast.toFixed(2)}:1)`)
      if (toggle.detailContrast != null) assert.ok(toggle.detailContrast >= 4.5, `detalle deshabilitado (${toggle.detailContrast.toFixed(2)}:1)`)
    }
    assert.notEqual(on[0].iconColor, off[0].iconColor, "el ícono también distingue el estado")
    assert.equal(focus.tag, "BUTTON")
    assert.equal(focus.outlineStyle, "solid", "foco de teclado visible")
    assert.equal(focus.outlineWidth, "2px")
  })
}

test("producto-form: los 4 controles viven en la MISMA fila y todos los toggles on/off usan el patrón único", () => {
  const read = (path: string) => readFileSync(path, "utf8")
  const form = read("app/admin/sections/productos/producto-form.tsx")
  const specs = read("app/admin/sections/productos/product-specifications-editor.tsx")
  const conditioned = read("app/admin/sections/productos/productos-row.tsx")
  const row = form.slice(form.indexOf('<div className="product-editor-financing-grid'), form.indexOf("product-installments-without-surcharge-note\"\n"))
  assert.match(row, /\{toggle\.label\}/)
  assert.match(row, /Mismo precio en contado y cuotas\s*<\/span>\s*<\/AdminSecondaryButton>\s*<\/div>/, "Mismo precio cierra la misma fila")
  assert.equal(form.match(/admin-toggle product-editor-financing-toggle/g)?.length, 2, "cuotas + mismo precio")
  assert.match(form, /admin-toggle inline-flex min-w-12/, "Estado / Destacado")
  assert.equal(specs.match(/className=\{`admin-toggle /g)?.length, 2, "especificación: botón y acción")
  assert.match(conditioned, /admin-toggle flex w-full/, "stock condicionado")
  assert.match(conditioned, /admin-toggle-track/)
  for (const source of [form, specs]) {
    assert.doesNotMatch(source, /product-editor-toggle-active|product-editor-spec-toggle-active|product-editor-spec-action-active/)
  }
})
