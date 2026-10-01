import type { Plugin } from "esbuild"

import type { MercadoPagoObservedCosts } from "../mercadopago/observed-costs.ts"

// Piezas compartidas por los tests de browser de Admin → Configuración y
// Admin → Financiación: stubs de infraestructura (sesión y banners), datos de
// ejemplo, HTML de la página y auditoría de contraste AA.

export const adminConfigStubs: Plugin = {
  name: "admin-config-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^@\/lib\/supabase\/client$/ }, () => ({ path: "supabase", namespace: "stub" }))
    pluginBuild.onResolve({ filter: /\/banners\/admin-banners$/ }, () => ({ path: "banners", namespace: "stub" }))
    pluginBuild.onLoad({ filter: /^supabase$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        export const supabase = { auth: { getSession: async () => ({ data: { session: { access_token: "t" } }, error: null }) } }
        export async function getSafeSupabaseSession() { return { access_token: "t" } }`,
    }))
    pluginBuild.onLoad({ filter: /^banners$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `export function AdminBanners() { return null }`,
    }))
  },
}

export const MANUAL = { baseProcessingPercent: 3.46, ivaPercent: 21, surchargePercentByCount: { 2: 7.79, 3: 10.49, 6: 18.69 } }

const CREDIT_OBSERVATION = {
  percentWithIva: 4.25,
  observedAt: "2026-09-30T20:48:46.000Z",
  paymentTypeId: "credit_card",
  paymentMethodId: "visa",
  installments: 1,
  releaseDays: 18,
  orderId: 18,
}
const SIX_OBSERVATION = {
  ...CREDIT_OBSERVATION,
  percentWithIva: 24.2,
  installments: 6,
  orderId: 21,
  observedAt: "2026-10-01T10:00:00.000Z",
}

export const OBSERVED: MercadoPagoObservedCosts = {
  base: CREDIT_OBSERVATION,
  surchargeByCount: { 2: null, 3: null, 6: SIX_OBSERVATION },
  singlePaymentByType: {
    credit_card: CREDIT_OBSERVATION,
    debit_card: null,
    account_money: { ...CREDIT_OBSERVATION, percentWithIva: 4.19, paymentTypeId: "account_money", paymentMethodId: "account_money", orderId: 17 },
  },
  analyzedPayments: 4,
  history: [
    { modality: "credit_6", previousPercentWithIva: 22.62, percentWithIva: 24.2, observedAt: SIX_OBSERVATION.observedAt, orderId: 21 },
    { modality: "credit_1", previousPercentWithIva: null, percentWithIva: 4.25, observedAt: CREDIT_OBSERVATION.observedAt, orderId: 18 },
  ],
  lastAppliedAt: SIX_OBSERVATION.observedAt,
}

const withoutIva = (percent: number) => Math.round((percent / 1.21) * 100) / 100

export function costsOverview(
  mode: "automatic" | "manual",
  observed: MercadoPagoObservedCosts | null,
  options: { enabled?: boolean; reference?: unknown; syncError?: string; offer?: unknown } = {},
) {
  const useObserved = mode === "automatic" && observed !== null
  const base = useObserved && observed.base ? withoutIva(observed.base.percentWithIva) : null
  const six = useObserved && observed.surchargeByCount[6] ? withoutIva(observed.surchargeByCount[6].percentWithIva) : null
  return {
    mode,
    manual: MANUAL,
    observed,
    interestFreePolicy: { enabled: options.enabled ?? true },
    interestFreeStatus: {
      reference: options.reference ?? null,
      lastAttemptAt: options.syncError ? "2026-10-01T13:00:00.000Z" : null,
      lastError: options.syncError ?? null,
      lastFailure: options.syncError ? { at: "2026-10-01T13:00:00.000Z", message: options.syncError } : null,
    },
    interestFreeOffer: options.offer ?? null,
    effective: {
      ...MANUAL,
      baseProcessingPercent: base ?? MANUAL.baseProcessingPercent,
      surchargePercentByCount: { ...MANUAL.surchargePercentByCount, 6: six ?? MANUAL.surchargePercentByCount[6] },
    },
    sources: {
      base: base === null ? "manual" : "observed",
      surchargeByCount: { 2: "manual", 3: "manual", 6: six === null ? "manual" : "observed" },
    },
  }
}

export const SETTINGS = {
  shipping: { defaultShippingCost: 9000, freeShippingMinAmount: 75000, shippingBonusMax: 12000, freeShippingMode: "full", logisticsBaseSubsidy: 3000 },
  customerCreditPayments: { mercadoPagoSurchargePercent: 0, mercadoPagoMinimumAmount: 10000 },
  stock: { criticalStockThreshold: 3, lowStockThreshold: 6, availableStockThreshold: 7 },
  pricing: { transferDiscountPercent: 10, nationalTaxesIncidencePercent: 21 },
  andreaniCommercial: { enabled: true },
  installmentsFinancing: MANUAL,
}

export const adminPageHtml = (theme: "dark" | "light", css: string, bundle: string) => `<!doctype html>
<html data-admin-theme="${theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>
<div class="beyonix-admin-shell"><main class="beyonix-admin-main"><div id="root"></div></main></div>
<script>window.process = { env: { NODE_ENV: "production" } }</script>
<script>${bundle}</script></body></html>`

// Se ejecuta en el navegador como string. Colores vía canvas (acepta
// lab/oklab/color-mix de Tailwind v4); fondo real componiendo capas.
export const CONTRAST_AUDIT = `(() => {
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  function parse(value) {
    if (!value || value === "transparent") return [0, 0, 0, 0]
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = "rgba(0,0,0,0)"
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3] / 255]
  }
  function firstStop(image) {
    const re = /(rgba?|lab|oklab|oklch|lch|hsla?|color)\\(/g
    const match = re.exec(image)
    if (!match) return null
    let i = match.index + match[0].length, level = 1
    while (i < image.length && level > 0) { if (image[i] === "(") level++; else if (image[i] === ")") level--; i++ }
    return image.slice(match.index, i)
  }
  function lum(c) {
    const ch = (v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
  }
  function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  function over(top, bottom) { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1] }
  function background(el) {
    const layers = []
    for (let node = el; node; node = node.parentElement) {
      const s = getComputedStyle(node)
      const stop = firstStop(s.backgroundImage)
      if (stop) { const c = parse(stop); layers.push(c); if (c[3] >= 0.95) break }
      const color = parse(s.backgroundColor)
      if (color[3] > 0) { layers.push(color); if (color[3] >= 0.95) break }
    }
    let result = document.documentElement.dataset.adminTheme === "light" ? [255, 255, 255, 1] : [2, 6, 10, 1]
    for (let i = layers.length - 1; i >= 0; i--) result = over(layers[i], result)
    return result
  }
  const failures = []
  let audited = 0
  for (const el of document.querySelector(".admin-config-page").querySelectorAll("*")) {
    if (el.closest("details:not([open])") && el.tagName !== "SUMMARY") continue
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim()
    if (!own || el.closest("button:disabled, input:disabled")) continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const s = getComputedStyle(el)
    if (s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue
    let opacity = 1
    for (let node = el; node; node = node.parentElement) opacity *= parseFloat(getComputedStyle(node).opacity)
    audited++
    const bg = background(el)
    const color = parse(s.color)
    const fg = over([color[0], color[1], color[2], color[3] * opacity], bg)
    const r = ratio(fg, bg)
    const size = parseFloat(s.fontSize)
    const large = size >= 18.66 || (size >= 14 && parseInt(s.fontWeight) >= 700)
    if (r < (large ? 3 : 4.5)) failures.push(own.slice(0, 40) + " -> " + r.toFixed(2) + " (" + s.color + " sobre rgb(" + bg.slice(0, 3).map(Math.round).join(",") + "), " + s.fontSize + ")")
  }
  return { audited, failures }
})()`
