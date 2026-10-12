import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { chromium, type Browser } from "playwright-core"
import { build } from "esbuild"

import { ProductDetailsModalCard } from "@/components/products/product-details-modal"
import type { SupabaseProducto } from "@/lib/supabase/types"

// Modal de producto real (galería + compra + descripción a todo el ancho) con
// el CSS compilado del proyecto, medido en Edge/Chrome en desktop, 1280,
// 1024, tablet y 390 px: nunca scroll horizontal, la descripción ocupa el
// ancho completo debajo de galería y compra, y la venta aleatoria se rotula
// sin selección falsa de color.

let browser: Browser
let css: string
let tooltipBundle: string
let galleryBundle: string

test.before(async () => {
  css = (await postcss([tailwindcss({ base: process.cwd() })])
    .process(readFileSync("app/globals.css", "utf8"), { from: "app/globals.css" })).css
  tooltipBundle = (await build({
    stdin: { contents: `import React from "react"; import { createRoot } from "react-dom/client"; import { RandomVariantHint } from "./components/products/random-variant-hint.tsx"; createRoot(document.getElementById("root")).render(<RandomVariantHint />);`,
      resolveDir: process.cwd(), sourcefile: "random-hint-browser-entry.tsx", loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic",
  })).outputFiles[0].text
  galleryBundle = (await build({
    stdin: { contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { ProductDetailsGallery } from "./components/products/product-details-gallery.tsx";
      function App() {
        const [selectedImage, setSelectedImage] = useState(0);
        window.selectedGalleryImage = selectedImage;
        return <ProductDetailsGallery images={["/placeholder.svg", "/placeholder-2.svg"]} videoUrl="https://example.com/product.mp4" selectedImage={selectedImage} productName="Producto" selectedStock={5} onNext={() => setSelectedImage((index) => (index + 1) % 3)} onPrev={() => setSelectedImage((index) => (index + 2) % 3)} onSelectImage={setSelectedImage} />;
      }
      createRoot(document.getElementById("root")).render(<App />);
    `, resolveDir: process.cwd(), sourcefile: "product-gallery-browser-entry.tsx", loader: "tsx" },
    bundle: true, platform: "browser", format: "iife", write: false,
    alias: { "@": process.cwd() }, jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  })).outputFiles[0].text
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true })
})

test.after(async () => {
  await browser?.close()
})

for (const width of [390, 1440]) test(`la imagen principal abre visor a ${width}px y salta el video al navegar`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: width === 390 })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent(`<html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body style="margin:0;background:#000"><div id="root"></div></body></html>`)
    await page.addScriptTag({ content: 'window.process = { env: { NODE_ENV: "production" } };' })
    await page.addScriptTag({ content: galleryBundle })
    await page.getByRole("button", { name: "Ampliar imagen de Producto" }).waitFor({ timeout: 5000 }).catch(() => {
      assert.fail(`La galería no montó: ${errors.join(" | ")}`)
    })
    const openButton = page.getByRole("button", { name: "Ampliar imagen de Producto" })
    assert.equal(await openButton.evaluate((button) => getComputedStyle(button).cursor), "pointer")
    if (width === 390) await openButton.tap()
    else await openButton.click()
    const dialog = page.getByRole("dialog", { name: "Imagen ampliada de Producto" })
    await dialog.waitFor()
    assert.equal(await dialog.locator("img").count(), 1)
    const imageArea = await dialog.locator("div.relative").boundingBox()
    assert.ok(imageArea && imageArea.width > (width === 390 ? 300 : 1000), "el visor usa el ancho disponible")
    const enlargedImage = dialog.locator("img")
    if (width === 390) await enlargedImage.tap()
    else await enlargedImage.click()
    assert.equal(await dialog.count(), 1, "click/tap en la imagen no cierra el visor")
    await dialog.getByRole("button", { name: "Imagen ampliada siguiente" }).click()
    assert.equal(await dialog.count(), 1, "la flecha sólo cambia la imagen")
    assert.equal(await page.evaluate(() => (window as unknown as { selectedGalleryImage: number }).selectedGalleryImage), 2)
    const backdrop = dialog.getByRole("button", { name: "Cerrar imagen ampliada" })
    if (width === 390) await backdrop.tap({ position: { x: 4, y: 4 } })
    else await backdrop.click({ position: { x: 4, y: 4 } })
    assert.equal(await dialog.count(), 0, "click/tap en el backdrop cierra el visor")
    if (width === 390) await openButton.tap()
    else await openButton.click()
    await dialog.getByRole("button", { name: "Cerrar visor de imagen" }).click()
    assert.equal(await dialog.count(), 0, "la X cierra sólo por su acción propia")
    if (width === 390) await openButton.tap()
    else await openButton.click()
    await page.keyboard.press("Escape")
    assert.equal(await dialog.count(), 0)
    assert.equal(await page.getByRole("button", { name: "Ampliar imagen de Producto" }).count(), 1)
  } finally { await page.close() }
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
function renderModal(item: SupabaseProducto = product, imageCount = 3) {
  return renderToStaticMarkup(createElement(ProductDetailsModalCard, {
  product: item,
  images: Array.from({ length: imageCount }, (_, index) => `/placeholder-${index}.svg`),
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
}
const markup = renderModal()

type Layout = {
  pageOverflow: number
  cardOverflow: number
  cardWidth: number
  description: { left: number; right: number; top: number; width: number }
  galleryBottom: number
  galleryTop: number
  galleryHeight: number
  galleryBackground: string
  stageWidth: number
  stageHeight: number
  stageBottom: number
  thumbnailsTop: number | null
  thumbnailCount: number
  panelBottom: number
  galleryLeft: number
  panelLeft: number
  panelTop: number
  descriptionClamped: boolean
}

async function measure(width: number, html = markup, withInstallments = false, height = 900): Promise<Layout> {
  const page = await browser.newPage({ viewport: { width, height } })
  try {
    await page.route("**/*", (route) => route.abort())
    await page.setContent(`<!doctype html>
<html lang="es"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
<body style="margin:0;background:#000"><div class="fixed inset-0 z-50 flex items-center justify-center bg-black/85 px-4 py-5">${html}</div></body></html>`)
    if (withInstallments) {
      // El test de layout añade la línea que muestra la configuración global
      // de cuotas; su contenido no interviene en el cálculo de la grid.
      await page.evaluate(() => {
        const purchase = document.querySelector("[data-product-price]")?.parentElement?.parentElement
        const line = document.createElement("p")
        line.textContent = "Hasta 12 cuotas sin interés"
        line.setAttribute("data-interest-free-global", "")
        purchase?.append(line)
      })
    }
    return (await page.evaluate(`(() => {
      const card = document.querySelector(".beyonix-modal-shell.custom-scrollbar")
      const [gallery, panel] = card.children[1] && card.children[2] ? [card.children[1], card.children[2]] : [null, null]
      const description = document.querySelector("[data-product-description]")
      const stage = document.querySelector("[data-gallery-stage]")
      const thumbnails = document.querySelector("[data-gallery-thumbnails]")
      const content = description.querySelector("div")
      const rect = (element) => element.getBoundingClientRect()
      return {
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        cardOverflow: card.scrollWidth - card.clientWidth,
        cardWidth: rect(card).width,
        description: { left: rect(description).left - rect(card).left, right: rect(card).right - rect(description).right, top: rect(description).top, width: rect(description).width },
        galleryBottom: rect(gallery).bottom,
        galleryTop: rect(gallery).top,
        galleryHeight: rect(gallery).height,
        galleryBackground: getComputedStyle(gallery).backgroundColor,
        stageWidth: rect(stage).width,
        stageHeight: rect(stage).height,
        stageBottom: rect(stage).bottom,
        thumbnailsTop: thumbnails ? rect(thumbnails).top : null,
        thumbnailCount: thumbnails?.querySelectorAll("[data-media-index]").length ?? 0,
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

for (const width of [1920, 1440, 1366, 1024, 768, 390]) {
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
      // La columna de compra acompaña todo el alto del sector superior: sin
      // hueco ni corte del borde entre el panel y el inicio de la descripción.
      assert.ok(Math.abs(layout.description.top - layout.panelBottom) <= 1, `panel ${layout.panelBottom} vs descripción ${layout.description.top}`)
    } else {
      // Mobile: apilado (la compra debajo de la galería).
      assert.ok(layout.panelTop >= layout.galleryBottom - 1, "en mobile la compra va debajo de la galería")
    }
    // Una descripción larga arranca recortada (el toggle "Ver más" la expande).
    assert.equal(layout.descriptionClamped, true)
  })
}

const shortDetails = renderModal({
  ...product,
  nombre: "Trípode",
  categorias: null,
  venta_aleatoria: false,
  producto_especificaciones: [],
  producto_variantes: [],
} as SupabaseProducto)

const tallDetails = renderModal({
  ...product,
  nombre: "Soporte de aluminio ajustable para escritorio y dispositivos",
  producto_especificaciones: Array.from({ length: 8 }, (_, index) => ({
    id: index + 1, producto_id: 7, icono: "Ruler",
    texto: `Característica ${index + 1} con detalles adicionales del soporte de aluminio`,
    orden: index + 1, activo: true,
  })),
} as SupabaseProducto)

for (const [scenario, html, withInstallments] of [
  ["galería alta y detalles cortos, sin cuotas", shortDetails, false],
  ["galería corta y detalles altos, sin cuotas", tallDetails, false],
  ["galería corta y detalles altos, con cuotas", tallDetails, true],
] as const) {
  for (const width of [1920, 1440, 1366, 1024, 768, 390]) {
    test(`${scenario} a ${width}px: columnas y descripción contiguas`, async () => {
      const layout = await measure(width, html, withInstallments)
      assert.ok(layout.pageOverflow <= 0 && layout.cardOverflow <= 0, "sin scroll horizontal")
      assert.ok(Math.abs(layout.description.left) <= 2 && Math.abs(layout.description.right) <= 2, "descripción full width")
      assert.equal(layout.galleryBackground, "rgb(8, 13, 19)", "la superficie de la galería cubre su columna")
      if (width >= 768) {
        assert.ok(Math.abs(layout.galleryBottom - layout.panelBottom) <= 1, `columnas: ${JSON.stringify(layout)}`)
        assert.ok(Math.abs(layout.description.top - layout.galleryBottom) <= 1, "descripción inmediatamente debajo")
        assert.ok(Math.abs(layout.stageWidth - layout.stageHeight) <= 1, "imagen cuadrada sin estirar")
      } else {
        assert.ok(layout.panelTop >= layout.galleryBottom - 1, "mobile apilado")
        assert.ok(layout.galleryHeight < 390, "mobile sin altura artificial")
        assert.ok(layout.description.top >= layout.panelBottom - 1, "descripción debajo del panel")
      }
    })
  }
}

// Perfiles tomados de los cuatro productos del catálogo: nombre, primeras
// ocho características visibles y cantidad de imágenes de su variante.
const catalogProfiles = [
  {
    name: "SOPORTE DE ALUMINIO NOTEBOOK/TABLET CON HUB USB 3.0", images: 5, installments: true,
    features: [
      "Compatible con notebooks de distintos tamaños.",
      "Fabricado en aluminio resistente, liviano y duradero.",
      "Estructura firme diseñada para brindar mayor estabilidad.",
      "Conexión USB para ampliar la conectividad de tus dispositivos.",
      "Permite conectar varios dispositivos USB desde un mismo punto.",
      "Tecnología USB 3.0 para transferencias de hasta 5 Gbps, según compatibilidad.",
      "Incluye cable USB para conectar el hub a tu notebook.",
      "Funciona mediante conexión USB, sin fuente externa para uso habitual.",
    ],
  },
  {
    name: "ENCENDEDOR ELECTRICO CON CARGA USB", images: 3, installments: true,
    features: [
      "Cuerpo liviano, resistente y duradero", "Recarga práctica mediante cable USB",
      "Incluye cable para recargarlo fácilmente", "Compatible con cargadores, PC y power bank",
      "Uso inalámbrico sin necesidad de enchufe", "Reutilizable, sin necesidad de gas descartable",
      "Producto revisado antes del despacho", "Encendido eléctrico rápido mediante resistencia",
    ],
  },
  {
    name: "TRIPODE INTELIGENTE CON SEGUIMIENTO FACIAL 360º", images: 4, installments: true,
    features: [
      "Firme y estable", "Cable USB incluido", "Su carga es mediante conexión USB",
      "Uso inalámbrico con batería integrada", "Conexión Bluetooth para control remoto",
      "Ideal para fotos y videos", "Giro completo de 360°", "Sigue automáticamente tus movimientos",
    ],
  },
  {
    name: "AURICULAR INALAMBRICO LEGATUS", images: 2, installments: false,
    features: [
      "Diseño cómodo y acolchado", "Conexión inalámbrica", "Incluye cable de carga",
      "Permite realizar llamadas", "Ajuste desde el auricular", "Uso sin cables",
      "Recargable por USB", "Sonido envolvente y claro",
    ],
  },
] as const

for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768]] as const) {
  test(`quick view de cuatro perfiles reales a ${width}×${height}: altura uniforme e imagen intacta`, async () => {
    const heights: number[] = []
    for (const profile of catalogProfiles) {
      const item = {
        ...product,
        nombre: profile.name,
        venta_aleatoria: false,
        producto_variantes: [],
        producto_especificaciones: profile.features.map((texto, index) => ({
          id: index + 1, producto_id: product.id, icono: "CircleHelp", texto,
          orden: index + 1, activo: true, created_at: "2026-01-01T00:00:00Z",
        })),
      } as SupabaseProducto
      const layout = await measure(width, renderModal(item, profile.images), profile.installments, height)
      heights.push(layout.galleryHeight)
      assert.equal(layout.thumbnailCount, profile.images, `${profile.name}: miniaturas`)
      assert.ok(Math.abs(layout.stageWidth - layout.stageHeight) <= 1, `${profile.name}: imagen cuadrada`)
      assert.ok(layout.stageWidth >= 500 && layout.stageWidth <= 600, `${profile.name}: imagen proporcionada`)
      assert.ok(layout.thumbnailsTop !== null && layout.thumbnailsTop - layout.stageBottom <= 80, `${profile.name}: miniaturas próximas`)
      assert.ok(Math.abs(layout.galleryBottom - layout.panelBottom) <= 1, `${profile.name}: columnas alineadas`)
      assert.ok(Math.abs(layout.galleryBottom - layout.description.top) <= 1, `${profile.name}: descripción inmediata`)
    }
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 75, `alturas: ${heights.join(", ")}`)
  })
}

test("quick view mobile de cuatro perfiles: galería natural y panel apilado", async () => {
  for (const profile of catalogProfiles) {
    const item = {
      ...product,
      nombre: profile.name,
      producto_especificaciones: profile.features.map((texto, index) => ({
        id: index + 1, producto_id: product.id, icono: "CircleHelp", texto,
        orden: index + 1, activo: true, created_at: "2026-01-01T00:00:00Z",
      })),
    } as SupabaseProducto
    const layout = await measure(390, renderModal(item, profile.images), profile.installments, 844)
    assert.ok(layout.galleryHeight < 390, `${profile.name}: sin alto artificial`)
    assert.ok(Math.abs(layout.galleryBottom - layout.panelTop) <= 1, `${profile.name}: apilado`)
    assert.ok(layout.description.top >= layout.panelBottom - 1, `${profile.name}: descripción debajo`)
  }
})

test("venta aleatoria en el modal: rótulo y ayuda, sin leyenda bajo miniaturas ni selector falso", () => {
  assert.match(markup, /Color\/modelo:/)
  assert.match(markup, /Aleatorio según disponibilidad/)
  assert.match(markup, /data-random-swatch="true"/)
  assert.match(markup, /aria-label="Qué significa color\/modelo aleatorio"/)
  assert.doesNotMatch(markup, /Imágenes ilustrativas de colores disponibles\./)
  assert.doesNotMatch(readFileSync("components/products/product-page-layout.tsx", "utf8"), /RANDOM_GALLERY_NOTE/)
  assert.doesNotMatch(markup, /Seleccionar color/)
  // La descripción enriquecida se renderiza como elementos (sin innerHTML).
  assert.match(markup, /<strong[^>]*>Sin gas ni piedras<\/strong>/)
  assert.doesNotMatch(markup, /&lt;p&gt;|&lt;strong&gt;/)
})

test("ayuda de variantes aleatorias: hover y tap muestran la aclaración, segundo tap la cierra", async () => {
  for (const hasTouch of [false, true]) {
    const page = await browser.newPage({ viewport: { width: hasTouch ? 390 : 1440, height: 800 }, hasTouch })
    try {
      await page.setContent(`<style>${css}</style><div id="root" style="margin:80px"></div>`)
      await page.addScriptTag({ content: tooltipBundle })
      const button = page.getByRole("button", { name: "Qué significa color/modelo aleatorio" })
      await button.waitFor()
      if (hasTouch) await button.tap()
      else await button.hover()
      assert.equal(await page.getByRole("tooltip").textContent(), "Las imágenes muestran variantes posibles. El color/modelo enviado depende del stock disponible.")
      if (hasTouch) {
        await button.tap()
        assert.equal(await page.getByRole("tooltip").count(), 0)
      }
    } finally { await page.close() }
  }
})

test("\"Ver más / Ver menos\" ocupa todo el ancho de la descripción", () => {
  const source = readFileSync("components/products/product-description-section.tsx", "utf8")
  assert.match(source, /className="mt-3 w-full cursor-pointer/)
  assert.match(source, /\{isExpanded \? "Ver menos" : "Ver más"\}/)
})
