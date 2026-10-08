import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { chromium, type Browser } from "playwright-core"

import { ProductDetailsModalCard } from "@/components/products/product-details-modal"
import type { SupabaseProducto } from "@/lib/supabase/types"

// Modal de producto real (galería + compra + descripción a todo el ancho) con
// el CSS compilado del proyecto, medido en Edge/Chrome en desktop, 1280,
// 1024, tablet y 390 px: nunca scroll horizontal, la descripción ocupa el
// ancho completo debajo de galería y compra, y la venta aleatoria se rotula
// sin selección falsa de color.

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

const LONG_DESCRIPTION = [
  "<h2>Encendedor recargable USB</h2>",
  "<p><strong>Sin gas ni piedras</strong>: se carga con el cable incluido.<br>Batería de larga duración.</p>",
  ...Array.from({ length: 8 }, (_, index) => `<p>Párrafo ${index + 1} con texto suficientemente largo para ocupar varias líneas en pantallas angostas y comprobar el recorte con «Ver más».</p>`),
  "<p>Palabralarguísimasinespaciosparaverificarquenoseproduceningúnscrollhorizontalenpantallaschicas</p>",
].join("")

const product = {
  id: 7,
  nombre: "Encendedor USB recargable con nombre largo para probar el ajuste",
  slug: "encendedor",
  precio: 10_000,
  precio_anterior: null,
  descuento: null,
  stock: 5,
  sku: "ENC",
  activo: true,
  venta_aleatoria: true,
  descripcion: LONG_DESCRIPTION,
  video_url: null,
  categorias: { nombre: "Accesorios" },
  imagenes_producto: [],
  producto_especificaciones: [
    { id: 1, producto_id: 7, icono: "Zap", texto: "Carga USB-C", orden: 1, activo: true },
    { id: 2, producto_id: 7, icono: "Shield", texto: "Resistente al viento", orden: 2, activo: true },
  ],
  producto_variantes: [
    { id: 71, producto_id: 7, nombre: "NEGRO", color_hex: "#000000", stock: 2, activo: true, imagenes: ["/placeholder.svg"], orden: 1 },
    { id: 72, producto_id: 7, nombre: "AZUL / ROSA", color_hex: "#2563EB", color_hex_secundario: "#EC4899", stock: 3, activo: true, imagenes: ["/placeholder.svg"], orden: 2 },
  ],
} as unknown as SupabaseProducto

const noop = () => {}
const markup = renderToStaticMarkup(createElement(ProductDetailsModalCard, {
  product,
  images: ["/placeholder.svg", "/placeholder.svg", "/placeholder.svg"],
  selectedImage: 0,
  selectedColor: "random",
  onClose: noop,
  onNext: noop,
  onPrev: noop,
  onSelectImage: noop,
  onColorChange: noop,
  onAddToCart: noop,
  onDecreaseCart: noop,
  onRemoveFromCart: noop,
  onViewCart: noop,
}))

type Layout = {
  pageOverflow: number
  cardOverflow: number
  cardWidth: number
  description: { left: number; right: number; top: number; width: number }
  galleryBottom: number
  panelBottom: number
  galleryLeft: number
  panelLeft: number
  panelTop: number
  descriptionClamped: boolean
}

async function measure(width: number): Promise<Layout> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  try {
    await page.route("**/*", (route) => route.abort())
    await page.setContent(`<!doctype html>
<html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body style="margin:0;background:#000"><div class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4 py-5">${markup}</div></body></html>`)
    return (await page.evaluate(`(() => {
      const card = document.querySelector(".beyonix-modal-shell.custom-scrollbar")
      const [gallery, panel] = card.children[1] && card.children[2] ? [card.children[1], card.children[2]] : [null, null]
      const description = document.querySelector("[data-product-description]")
      const content = description.querySelector("div")
      const rect = (element) => element.getBoundingClientRect()
      return {
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
        cardWidth: rect(card).width,
        description: { left: rect(description).left - rect(card).left, right: rect(card).right - rect(description).right, top: rect(description).top, width: rect(description).width },
        galleryBottom: rect(gallery).bottom,
        panelBottom: rect(panel).bottom,
        galleryLeft: rect(gallery).left,
        panelLeft: rect(panel).left,
        panelTop: rect(panel).top,
        descriptionClamped: content.scrollHeight > content.clientHeight + 1,
      }
    })()`)) as Layout
  } finally {
    await page.close()
  }
}

for (const width of [1440, 1280, 1024, 768, 390]) {
  test(`modal de producto a ${width}px: sin scroll horizontal y descripción a todo el ancho debajo`, async () => {
    const layout = await measure(width)
    assert.ok(layout.pageOverflow <= 0, `scroll horizontal de página: ${layout.pageOverflow}px`)
    assert.ok(layout.cardOverflow <= 0, `scroll horizontal del modal: ${layout.cardOverflow}px`)
    // Descripción: ocupa todo el ancho de la tarjeta (sin bordes laterales).
    assert.ok(Math.abs(layout.description.left) <= 2 && Math.abs(layout.description.right) <= 2, JSON.stringify(layout.description))
    assert.ok(layout.description.top >= Math.max(layout.galleryBottom, layout.panelBottom) - 1, "la descripción queda debajo de galería y compra")
    if (width >= 768) {
      // Galería a la izquierda, compra a la derecha (misma fila).
      assert.ok(layout.galleryLeft < layout.panelLeft, "galería a la izquierda de la compra")
    } else {
      // Mobile: apilado (la compra debajo de la galería).
      assert.ok(layout.panelTop >= layout.galleryBottom - 1, "en mobile la compra va debajo de la galería")
    }
    // Una descripción larga arranca recortada (el toggle "Ver más" la expande).
    assert.equal(layout.descriptionClamped, true)
  })
}

test("venta aleatoria en el modal: rótulo, ayuda y nota de imágenes; sin selector falso de color", () => {
  assert.match(markup, /Color\/modelo:/)
  assert.match(markup, /Aleatorio según stock/)
  assert.match(markup, /aria-label="Qué significa color\/modelo aleatorio"/)
  assert.match(markup, /Imágenes ilustrativas de colores disponibles\./)
  assert.doesNotMatch(markup, /Seleccionar color/)
  // La descripción enriquecida se renderiza como elementos (sin innerHTML).
  assert.match(markup, /<strong[^>]*>Sin gas ni piedras<\/strong>/)
  assert.doesNotMatch(markup, /&lt;p&gt;|&lt;strong&gt;/)
})

test("\"Ver más / Ver menos\" ocupa todo el ancho de la descripción", () => {
  const source = readFileSync("components/products/product-description-section.tsx", "utf8")
  assert.match(source, /className="mt-3 w-full cursor-pointer/)
  assert.match(source, /\{isExpanded \? "Ver menos" : "Ver más"\}/)
})
