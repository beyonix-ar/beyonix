import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Modal "Marcar Entregado" (ForcedStatusConfirmModal) y "Gestionar reclamo"
// (DecisionButton de AdminClaimManager): mismos bugs que ya tuvieron el modal
// de rechazo, badges y pills -- utilidades que las reglas globales del admin
// reescriben en Light (texto oscuro sobre fondo oscuro, botón celeste pálido
// con texto blanco) y el catch-all de botones del detalle que volvía todas
// las acciones navy.

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const pedidos = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")
const claims = readSource("../../components/claims/admin-claim-manager.tsx")
const css = readSource("../../app/globals.css")

function sliceFunction(source: string, signature: string) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, signature)
  return source.slice(start, source.indexOf("\n}\n", start))
}

function relativeLuminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: string, background: string) {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

function ruleBody(selector: string) {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `falta ${selector}`)
  return css.slice(start, css.indexOf("}", start))
}

function hex(body: string, property: string) {
  const match = body.match(new RegExp(`(?:^|[\\n{;])\\s*${property}: (#[0-9a-f]{6})`, "i"))
  assert.ok(match, `${property} en ${body.slice(0, 90)}`)
  return match[1]
}

const MODAL = ':is(html, html[data-admin-theme="light"]) .admin-status-modal'

test("modal Entregado: clases propias, sin utilidades que el tema Light reescribe", () => {
  const modal = sliceFunction(pedidos, "function ForcedStatusConfirmModal(")
  for (const part of ["__header", "__eyebrow", "__title", "__subtitle", "__customer", "__warning", "__footer", "__cancel", "__confirm"]) {
    assert.match(modal, new RegExp(`admin-status-modal${part}`), part)
  }
  assert.match(modal, /aria-labelledby="forced-status-modal-title"/)
  const modalClasses = [...modal.matchAll(/className="([^"]+)"/g)].map((match) => match[1]).join(" ")
  assert.doesNotMatch(modalClasses, /text-white\/\d+|text-amber-100|bg-beyonix-blue|text-beyonix-sky|bg-\[#101010\]|bg-\[linear-gradient/)
  // Ningún contenedor con rounded + border (catch-all de superficies).
  for (const [, classes] of modal.matchAll(/className="([^"]+)"/g)) {
    assert.ok(!(classes.includes("rounded") && /\bborder\b/.test(classes)), classes)
  }
  // Lógica intacta: mismos handlers y etiquetas.
  assert.match(modal, /onClick=\{onCancel\}[\s\S]*?Cancelar/)
  assert.match(modal, /onClick=\{onConfirm\}[\s\S]*?\{loading \? "Confirmando\.\.\." : `Marcar \$\{statusLabel\}`\}/)
})

test("modal Entregado: contraste AA en ambos temas (header, textos, cajas y botones)", () => {
  const header = "#123150"
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__title`), "color"), header) >= 7)
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__subtitle`), "color"), header) >= 7)
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__eyebrow`), "color"), header) >= 4.5)
  const customer = ruleBody(`${MODAL} .admin-status-modal__customer`)
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__customer-name`), "color"), hex(customer, "background")) >= 7)
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__label`), "color"), hex(customer, "background")) >= 7)
  const modalBg = hex(ruleBody(MODAL), "background")
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__warning`), "color"), modalBg) >= 7)
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__cancel`), "color"), modalBg) >= 7)
  const confirm = ruleBody(`${MODAL} .admin-status-modal__confirm`)
  assert.ok(contrast(hex(confirm, "color"), hex(confirm, "background")) >= 4.5)
  const hover = ruleBody(`${MODAL} .admin-status-modal__confirm:not(:disabled):hover`)
  assert.ok(contrast("#ffffff", hex(hover, "background")) >= 4.5)
  const disabled = ruleBody(`${MODAL} .admin-status-modal__confirm:disabled`)
  assert.ok(contrast(hex(disabled, "color"), hex(disabled, "background")) >= 4.5)
  assert.match(css, /\.admin-status-modal :is\(\.admin-status-modal__cancel, \.admin-status-modal__confirm\):focus-visible \{/)
})

test("Gestionar reclamo: DecisionButton sin rounded+border ni text-white/N", () => {
  const decision = sliceFunction(claims, "function DecisionButton(")
  assert.match(decision, /className=\{`admin-claim-decision-button is-\$\{tone\}/)
  assert.match(decision, /admin-claim-decision-icon/)
  assert.match(decision, /admin-claim-decision-title/)
  assert.match(decision, /admin-claim-decision-description/)
  const decisionClasses = [...decision.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)]
    .map((match) => match[1] ?? match[2])
    .join(" ")
  assert.doesNotMatch(decisionClasses, /rounded-lg|\bborder\b|text-white|disabled:opacity-45/)

  const panel = claims.slice(claims.indexOf("Gestionar reclamo</h4>"), claims.indexOf("Gestionar conversación"))
  for (const name of ["admin-claim-status-box", "admin-claim-status-value", "admin-claim-resolution-box", "admin-claim-closed-note", "admin-claim-closed-title"]) {
    assert.ok(panel.includes(name), name)
  }
  assert.doesNotMatch(panel, /text-\[#D7FFFD\]|text-blue-200\/75|bg-black\/20 px-2\.5/)
  // Lógica intacta: mismas acciones y tonos semánticos.
  assert.match(panel, /title="El reclamo es válido"[\s\S]*?tone="success"/)
  assert.match(panel, /title="El reclamo no corresponde"[\s\S]*?tone="danger"/)
  assert.match(panel, /title="Finalizar reclamo"[\s\S]*?tone="primary"/)
})

test("Gestionar reclamo: cada tono se distingue y se lee en Light y Dark", () => {
  const vars = (selector: string) => {
    const body = ruleBody(selector)
    return {
      bg: hex(body, "--claim-decision-bg"),
      title: body.match(/--claim-decision-title: (#[0-9a-f]{6}|rgba?\([^)]*\))/i)?.[1] ?? "",
      text: body.match(/--claim-decision-text: (#[0-9a-f]{6}|rgba?\([^)]*\))/i)?.[1] ?? "",
    }
  }
  const lightTones = {
    success: vars('html[data-admin-theme="light"] .admin-claim-decision-button.is-success'),
    danger: vars('html[data-admin-theme="light"] .admin-claim-decision-button.is-danger'),
    primary: vars('html[data-admin-theme="light"] .admin-claim-decision-button.is-primary'),
  }
  for (const [tone, { bg, title, text }] of Object.entries(lightTones)) {
    assert.ok(relativeLuminance(bg) > 0.8, `${tone}: fondo claro en Light`)
    assert.ok(contrast(title, bg) >= 7, `${tone}: título`)
    assert.ok(contrast(text, bg) >= 4.5, `${tone}: descripción`)
  }
  assert.equal(new Set(Object.values(lightTones).map((tone) => tone.bg)).size, 3, "tonos distintos")

  // Dark: fondos de tono conservados con texto blanco.
  for (const [tone, bg] of [["success", "#075032"], ["danger", "#6f1d1d"], ["primary", "#112a43"]] as const) {
    assert.equal(hex(ruleBody(`.admin-claim-decision-button.is-${tone}`), "--claim-decision-bg"), bg)
    assert.ok(contrast("#ffffff", bg) >= 7, tone)
  }
  const muted = vars('html[data-admin-theme="light"] .admin-claim-decision-button.is-disabled-muted:disabled')
  assert.ok(contrast(muted.title, muted.bg) >= 4.5, "deshabilitado sigue legible")
  assert.match(ruleBody(".admin-claim-decision-button:disabled"), /opacity: 0\.6;/)

  const status = ruleBody('html[data-admin-theme="light"] .admin-claim-status-box')
  assert.ok(contrast(hex(ruleBody('html[data-admin-theme="light"] .admin-claim-status-value'), "color"), hex(status, "background")) >= 7)
  const closed = ruleBody('html[data-admin-theme="light"] .admin-claim-closed-note')
  assert.ok(contrast(hex(ruleBody('html[data-admin-theme="light"] .admin-claim-closed-title'), "color"), hex(closed, "background")) >= 4.5)
})

test("el catch-all de botones del detalle ya no aplasta las acciones del reclamo", () => {
  const catchAll = '.admin-order-detail-scope .admin-order-detail-content :is(button, a):not(:disabled):not([aria-label*="Eliminar"]):not([class*="danger"]):not([aria-label="Estado del pago"]):not(.admin-order-shipping-status-select)'
  const occurrences = css.split(catchAll).length - 1
  assert.equal(occurrences, 4)
  assert.equal(css.split(`${catchAll}:not(.admin-claim-decision-button)`).length - 1, occurrences)
  assert.equal(css.split(`${catchAll}:not(.admin-claim-decision-button):not(.admin-claim-flow-control)`).length - 1, occurrences)
})

test("flujo del reclamo: botones y opciones con clases propias, excluidos del catch-all", () => {
  const flow = sliceFunction(claims, "function ReplacementFlowSteps(")
  const flowClasses = [...flow.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].map((match) => match[1] ?? match[2]).join(" ")
  assert.doesNotMatch(flowClasses, /text-white|rounded-lg|\bborder\b|bg-\[#/)
  assert.match(flow, /admin-claim-flow-button admin-claim-flow-control \$\{active \? "is-primary" : "is-secondary"\}/)
  assert.match(flow, /"Confirmar envío o entrega"/)
  assert.match(flow, /"Registrar reemplazo"/)
  assert.doesNotMatch(claims, /Ya registré el reemplazo|Registrar reemplazo con salida de stock|Guardar recepción|Solución aprobada por BEYONIX/)

  const panel = sliceFunction(claims, "export function ReturnInventoryPanel(")
  assert.match(panel, /Recepción del producto original/)
  assert.match(panel, /¿Qué hacemos con esta unidad\?/)
  assert.equal(panel.split("admin-claim-choice admin-claim-flow-control").length - 1, 2)
  assert.doesNotMatch(panel, /Vendió \{|Solución aprobada/)
})

test("flujo del reclamo: primario, secundario, deshabilitado y opciones legibles en ambos temas", () => {
  const button = (selector: string) => {
    const body = ruleBody(selector)
    return { bg: hex(body, "--claim-button-bg"), text: hex(body, "--claim-button-text") }
  }
  const lightPrimary = button('html[data-admin-theme="light"] .admin-claim-flow-button.is-primary')
  assert.ok(contrast(lightPrimary.text, lightPrimary.bg) >= 7)
  const lightSecondary = button('html[data-admin-theme="light"] .admin-claim-flow-button')
  assert.ok(contrast(lightSecondary.text, lightSecondary.bg) >= 7)
  const lightDisabled = button('html[data-admin-theme="light"] .admin-claim-flow-button:disabled')
  assert.ok(contrast(lightDisabled.text, lightDisabled.bg) >= 4.5)
  assert.notEqual(lightDisabled.bg, lightPrimary.bg)
  for (const stop of ["#2f74ab", "#1f5686"]) assert.ok(contrast("#ffffff", stop) >= 4.5, stop)

  const choice = (selector: string) => {
    const body = ruleBody(selector)
    return { bg: hex(body, "--claim-choice-bg"), title: hex(body, "--claim-choice-title") }
  }
  const restock = choice('html[data-admin-theme="light"] .admin-claim-choice.is-restock[aria-pressed="true"]')
  const writeoff = choice('html[data-admin-theme="light"] .admin-claim-choice.is-writeoff[aria-pressed="true"]')
  assert.ok(contrast(restock.title, restock.bg) >= 7)
  assert.ok(contrast(writeoff.title, writeoff.bg) >= 7)
  assert.notEqual(restock.bg, writeoff.bg)
  const lightChoice = ruleBody('html[data-admin-theme="light"] .admin-claim-choice')
  // El tile es un control elevado: su fondo sale del token de superficie
  // "raised" del admin (sistema semántico de superficies).
  assert.match(lightChoice, /--claim-choice-bg: var\(--bx-surface-raised\);/)
  const adminTokens = ruleBody('html[data-admin-theme="light"] :is(.beyonix-admin-shell, .admin-portal-scope)')
  assert.ok(contrast(hex(lightChoice, "--claim-choice-text"), hex(adminTokens, "--bx-surface-raised")) >= 4.5)

  const success = ruleBody('html[data-admin-theme="light"] .admin-claim-notice-success')
  assert.ok(contrast(hex(success, "color"), hex(success, "background")) >= 7)
})

test("flujo del reclamo: tooltips, pills y contadores legibles; ayuda accesible", () => {
  const darkTip = ruleBody(".admin-claim-help-bubble")
  assert.ok(contrast(hex(darkTip, "color"), hex(darkTip, "background")) >= 7)
  const lightTip = ruleBody('html[data-admin-theme="light"] .admin-claim-help-bubble')
  assert.ok(contrast(hex(lightTip, "color"), hex(lightTip, "background")) >= 7)
  assert.match(css, /\.admin-claim-help:hover \.admin-claim-help-bubble,\n\.admin-claim-help:focus-within \.admin-claim-help-bubble \{/)

  const pill = (tone: string) => {
    const body = ruleBody(`html[data-admin-theme="light"] .admin-claim-pill${tone}`)
    return contrast(hex(body, "--claim-pill-text"), hex(body, "--claim-pill-bg"))
  }
  for (const tone of ["", ".is-brand", ".is-success", ".is-warning", ".is-danger"]) {
    assert.ok(pill(tone) >= 4.5, `pill${tone}`)
  }

  const tip = sliceFunction(claims, "function ClaimHelpTip(")
  assert.match(tip, /aria-describedby=\{tooltipId\}/)
  assert.match(tip, /role="tooltip"/)
  assert.match(tip, /event\.key === "Escape"/)
  assert.match(tip, /admin-claim-help-trigger admin-claim-flow-control/)
})

test("modal de seguimiento: comparte la isla admin-status-modal y no usa utilidades interceptadas", () => {
  const modal = sliceFunction(pedidos, "function TrackingStatusModal(")
  for (const part of ["__header", "__eyebrow", "__title", "__subtitle", "__field-label", "__input", "__note", "__footer", "__cancel", "__confirm"]) {
    assert.match(modal, new RegExp(`admin-status-modal${part}`), part)
  }
  assert.match(modal, /aria-labelledby="tracking-status-modal-title"/)
  // Se excluye el backdrop (bg-black/82 fuera de la isla, igual en todos los modales).
  const classes = [...modal.matchAll(/className="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !value.startsWith("fixed inset-0"))
  assert.doesNotMatch(
    classes.join(" "),
    /text-white|text-beyonix-sky|bg-beyonix-blue|bg-\[#|bg-black\/|placeholder:|focus:border|disabled:opacity/,
  )
  for (const value of classes) {
    assert.ok(!(value.includes("rounded") && /\bborder\b/.test(value)), value)
  }
  // El label no puede llevar tracking-widest: la regla global de "eyebrows"
  // (span[class*="tracking-widest"]) le fuerza --admin-text-muted !important.
  for (const value of classes.filter((item) => item.includes("__field-label"))) {
    assert.doesNotMatch(value, /tracking-widest/)
  }
  // Lógica intacta: mismo estado, mismos handlers y mismo payload.
  assert.match(modal, /onChange=\{\(event\) => setTrackingNumber\(event\.target\.value\)\}/)
  assert.match(modal, /onChange=\{\(event\) => setTrackingUrl\(event\.target\.value\)\}/)
  assert.match(modal, /tracking_number: trackingNumber\.trim\(\) \|\| null,\s*tracking_url: normalizeExternalUrl\(trackingUrl\),/)
  assert.match(modal, /onClick=\{onCancel\}\s*disabled=\{loading\}/)
  assert.match(modal, /\{loading\s*\?\s*"Guardando\.\.\."\s*:\s*isEditing\s*\?\s*"Guardar cambios"\s*:\s*"Guardar seguimiento"\}/)
})

test("modal de seguimiento: labels, inputs, placeholder y nota legibles en ambos temas", () => {
  const modalBg = hex(ruleBody(MODAL), "background")
  const label = ruleBody(`${MODAL} .admin-status-modal__field-label`)
  assert.ok(contrast(hex(label, "color"), modalBg) >= 7)
  assert.doesNotMatch(label, /!important/)
  assert.match(label, /letter-spacing: 0\.1em;/)

  const input = ruleBody(`${MODAL} .admin-status-modal__input`)
  const inputBg = hex(input, "background-color")
  assert.ok(contrast(hex(input, "color"), inputBg) >= 7)
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__input::placeholder`), "color"), inputBg) >= 4.5)
  assert.match(css, /\.admin-status-modal \.admin-status-modal__input:focus,\n[^\n]*\.admin-status-modal__input:focus-visible \{\n  border-color: #8cc8f2 !important;/)

  const note = ruleBody(`${MODAL} .admin-status-modal__note`)
  assert.ok(contrast(hex(note, "color"), hex(note, "background")) >= 7)
  assert.doesNotMatch(note, /!important/)

  // Disabled compartido con ForcedStatusConfirmModal: legible, sin opacidad.
  const disabled = ruleBody(`${MODAL} .admin-status-modal__confirm:disabled`)
  assert.ok(contrast(hex(disabled, "color"), hex(disabled, "background")) >= 4.5)
  assert.ok(contrast(hex(ruleBody(`${MODAL} .admin-status-modal__cancel:disabled`), "color"), modalBg) >= 7)
})
