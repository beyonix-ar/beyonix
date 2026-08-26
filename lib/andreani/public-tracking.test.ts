import assert from "node:assert/strict"
import test from "node:test"

import {
  ANDREANI_PUBLIC_TRACKING_PAGE_URL,
  resolveOrderTrackingLink,
} from "./public-tracking.ts"

test("un envío creado por Andreani abre la página oficial y expone el tracking DE ESE pedido", () => {
  const result = resolveOrderTrackingLink({
    andreani_tracking: "360003079278920",
    tracking_number: null,
    tracking_url: null,
  })

  assert.equal(result.trackingNumber, "360003079278920")
  assert.equal(result.url, ANDREANI_PUBLIC_TRACKING_PAGE_URL)
  assert.equal(result.isAndreani, true)
})

test("dos pedidos con distinto andreani_tracking nunca comparten el mismo número resuelto", () => {
  const a = resolveOrderTrackingLink({ andreani_tracking: "360000000000001" })
  const b = resolveOrderTrackingLink({ andreani_tracking: "360000000000002" })

  assert.notEqual(a.trackingNumber, b.trackingNumber)
  assert.equal(a.trackingNumber, "360000000000001")
  assert.equal(b.trackingNumber, "360000000000002")
  // Ambos abren la misma página oficial -- Andreani no documenta una URL
  // profunda por tracking -- pero nunca el mismo NÚMERO.
  assert.equal(a.url, b.url)
})

test("no inventa un query param de tracking sobre la URL pública oficial", () => {
  const result = resolveOrderTrackingLink({ andreani_tracking: "360003079278920" })

  assert.equal(result.url, "https://www.andreani.com/?tab=seguir-envio")
  assert.doesNotMatch(result.url ?? "", /360003079278920/)
})

test("un transportista manual con tracking_url propio conserva su enlace", () => {
  const result = resolveOrderTrackingLink({
    andreani_tracking: null,
    tracking_number: "OCA-123",
    tracking_url: "www.oca.com.ar/seguimiento/OCA-123",
  })

  assert.equal(result.trackingNumber, "OCA-123")
  assert.equal(result.url, "https://www.oca.com.ar/seguimiento/OCA-123")
  assert.equal(result.isAndreani, false)
})

test("un transportista manual sin tracking_url no ofrece enlace, solo el número", () => {
  const result = resolveOrderTrackingLink({
    tracking_number: "OCA-123",
    tracking_url: null,
  })

  assert.equal(result.trackingNumber, "OCA-123")
  assert.equal(result.url, null)
})

test("sin ningún dato de seguimiento, no hay número ni URL", () => {
  const result = resolveOrderTrackingLink({})

  assert.equal(result.trackingNumber, null)
  assert.equal(result.url, null)
  assert.equal(result.isAndreani, false)
})

test("andreani_tracking siempre gana sobre un tracking_url manual residual", () => {
  const result = resolveOrderTrackingLink({
    andreani_tracking: "360003079278920",
    tracking_url: "https://otro-transportista.example/seguimiento",
  })

  assert.equal(result.isAndreani, true)
  assert.equal(result.url, ANDREANI_PUBLIC_TRACKING_PAGE_URL)
})
