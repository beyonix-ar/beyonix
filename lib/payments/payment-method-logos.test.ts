import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  findCreditLogo,
  getCheckoutCashLogoGroups,
  getPaymentMethodVisibility,
  getSvgSafetyError,
  normalizePaymentMethodName,
  parseMercadoPagoPaymentMethods,
  planPaymentMethodSync,
  toPublicPaymentMethodLogos,
  validatePaymentLogoUpload,
  type PaymentMethodLogoRow,
} from "./payment-method-logos.ts"

// Respuesta real (resumida) de GET /v1/payment_methods de la cuenta: el mismo
// id aparece con distintos payment_type_id (visa crédito y prepaga).
const MP_RESPONSE = [
  { id: "visa", name: "Visa Prepaid", payment_type_id: "prepaid_card", status: "active" },
  { id: "visa", name: "Visa", payment_type_id: "credit_card", status: "active" },
  { id: "master", name: "Mastercard", payment_type_id: "credit_card", status: "active" },
  { id: "debvisa", name: "Visa Débito", payment_type_id: "debit_card", status: "active" },
  { id: "amex", name: "American Express", payment_type_id: "credit_card", status: "active" },
  { id: "naranja", name: "Naranja", payment_type_id: "credit_card", status: "active" },
  { id: "rapipago", name: "Rapipago", payment_type_id: "ticket", status: "active" },
]
const NOW = "2026-10-06T12:00:00.000Z"
const LATER = "2026-10-07T12:00:00.000Z"

function row(overrides: Partial<PaymentMethodLogoRow>): PaymentMethodLogoRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source: "mercadopago",
    provider_method_id: "visa",
    provider_name: "Visa",
    provider_payment_types: ["credit_card", "prepaid_card"],
    provider_status: "active",
    display_name: "Visa",
    image_path: "00000000-0000-4000-8000-000000000001/1759752000000.svg",
    enabled: true,
    needs_review: false,
    first_seen_at: NOW,
    last_seen_at: NOW,
    last_synced_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

/** Aplica un plan sobre filas en memoria (lo mismo que hace el servidor). */
function applyPlan(rows: PaymentMethodLogoRow[], plan: ReturnType<typeof planPaymentMethodSync>) {
  const next = rows.map((current) => {
    const update = plan.updates.find((item) => item.id === current.id)
    return update ? { ...current, ...update.changes } : current
  })
  plan.inserts.forEach((insert, index) => {
    next.push({ ...row({}), ...insert, id: `00000000-0000-4000-8000-1000000000${String(index).padStart(2, "0")}`, image_path: null })
  })
  return next
}

test("parsea /v1/payment_methods agrupando por id; nombre del tipo principal y todos sus tipos", () => {
  const methods = parseMercadoPagoPaymentMethods(MP_RESPONSE)
  assert.ok(methods)
  const visa = methods.find((method) => method.id === "visa")
  assert.deepEqual(visa, { id: "visa", name: "Visa", paymentTypes: ["credit_card", "prepaid_card"], active: true })
  assert.equal(methods.filter((method) => method.id === "visa").length, 1, "un solo registro por payment_method_id")
  assert.equal(methods.length, 6)
})

test("respuesta inválida de Mercado Pago: null (no se toca el último estado conocido)", () => {
  assert.equal(parseMercadoPagoPaymentMethods({ message: "unauthorized" }), null)
  assert.equal(parseMercadoPagoPaymentMethods([{ foo: 1 }]), null)
  assert.deepEqual(parseMercadoPagoPaymentMethods([]), [])
  // Una entrada rota no invalida las demás.
  assert.equal(parseMercadoPagoPaymentMethods([...MP_RESPONSE, { id: "../x", name: "x", payment_type_id: "credit_card", status: "active" }])?.length, 6)
})

test("ciclo completo: activo visible → MP lo elimina (oculto, imagen conservada) → MP lo reactiva (visible)", () => {
  const methods = parseMercadoPagoPaymentMethods(MP_RESPONSE)!
  let rows = applyPlan([], planPaymentMethodSync([], methods, NOW))
  assert.equal(rows.length, 6)
  assert.ok(rows.every((item) => !item.needs_review), "la primera importación no marca todo como nuevo")
  assert.ok(rows.every((item) => item.enabled), "Mercado Pago: habilitado por defecto, se muestra al cargar la imagen")

  const visaId = rows.find((item) => item.provider_method_id === "visa")!.id
  rows = rows.map((item) => (item.id === visaId ? { ...item, image_path: `${visaId}/1759752000000.svg` } : item))
  const visa = () => rows.find((item) => item.id === visaId)!
  assert.deepEqual(getPaymentMethodVisibility(visa()), { visible: true })

  // MP deja de devolver visa.
  const withoutVisa = parseMercadoPagoPaymentMethods(MP_RESPONSE.filter((entry) => entry.id !== "visa"))!
  const removal = planPaymentMethodSync(rows, withoutVisa, LATER)
  assert.equal(removal.summary.missing, 1)
  rows = applyPlan(rows, removal)
  assert.equal(visa().provider_status, "missing")
  assert.equal(visa().image_path, `${visaId}/1759752000000.svg`, "la imagen nunca se borra")
  assert.deepEqual(getPaymentMethodVisibility(visa()), { visible: false, reason: "provider_missing" })
  assert.equal(rows.length, 6, "nunca se borran filas")

  // MP lo desactiva (sigue figurando, status != active).
  const deactivated = parseMercadoPagoPaymentMethods(MP_RESPONSE.map((entry) => (entry.id === "visa" ? { ...entry, status: "deactive" } : entry)))!
  rows = applyPlan(rows, planPaymentMethodSync(rows, deactivated, LATER))
  assert.deepEqual(getPaymentMethodVisibility(visa()), { visible: false, reason: "provider_inactive" })

  // MP lo reactiva: reaparece solo, sin intervención.
  const reactivation = planPaymentMethodSync(rows, methods, LATER)
  assert.equal(reactivation.summary.reactivated, 1)
  rows = applyPlan(rows, reactivation)
  assert.deepEqual(getPaymentMethodVisibility(visa()), { visible: true })
})

test("medio nuevo después de la primera importación: 'Nuevo medio disponible' y sin logo inventado", () => {
  const rows = applyPlan([], planPaymentMethodSync([], parseMercadoPagoPaymentMethods(MP_RESPONSE)!, NOW))
  const plan = planPaymentMethodSync(
    rows,
    parseMercadoPagoPaymentMethods([...MP_RESPONSE, { id: "cabal", name: "Cabal", payment_type_id: "credit_card", status: "active" }])!,
    LATER,
  )
  assert.equal(plan.inserts.length, 1)
  assert.equal(plan.inserts[0].provider_method_id, "cabal")
  assert.equal(plan.inserts[0].needs_review, true)
  assert.equal("image_path" in plan.inserts[0], false, "nunca se asigna una imagen automáticamente")
  const next = applyPlan(rows, plan)
  assert.deepEqual(getPaymentMethodVisibility(next.find((item) => item.provider_method_id === "cabal")!), { visible: false, reason: "no_image" })
})

test("visibilidad: imagen, activo en BEYONIX, disponible en MP y tipo ofrecido por el checkout", () => {
  assert.deepEqual(getPaymentMethodVisibility(row({ image_path: null })), { visible: false, reason: "no_image" })
  assert.deepEqual(getPaymentMethodVisibility(row({ enabled: false })), { visible: false, reason: "disabled" })
  assert.deepEqual(
    getPaymentMethodVisibility(row({ provider_method_id: "rapipago", provider_payment_types: ["ticket"] })),
    { visible: false, reason: "not_offered" },
    "Rapipago/Pago Fácil: el checkout los excluye, nunca se promete",
  )
})

test("medio manual/externo: oculto hasta habilitarlo; nunca se presenta como medio de Mercado Pago", () => {
  const modo = row({
    id: "00000000-0000-4000-8000-000000000099",
    source: "manual",
    provider_method_id: null,
    provider_name: null,
    provider_payment_types: [],
    provider_status: null,
    display_name: "MODO",
    image_path: "00000000-0000-4000-8000-000000000099/1759752000000.png",
    enabled: false,
  })
  assert.deepEqual(getPaymentMethodVisibility(modo), { visible: false, reason: "disabled" })
  const enabled = { ...modo, enabled: true }
  assert.deepEqual(getPaymentMethodVisibility(enabled), { visible: true })

  const logos = toPublicPaymentMethodLogos([row({}), enabled], (path) => `https://cdn.test/${path}`)
  assert.deepEqual(logos.map((logo) => logo.name), ["Visa", "MODO"])
  assert.deepEqual(logos[1].paymentTypes, [])
  const groups = getCheckoutCashLogoGroups(logos)
  assert.deepEqual(groups.map((group) => [group.id, group.logos.map((logo) => logo.name)]), [["credit", ["Visa"]]])
})

test("checkout: logos agrupados por tipo principal, logo de crédito por marca", () => {
  const logos = toPublicPaymentMethodLogos(
    [
      row({}),
      row({ id: "00000000-0000-4000-8000-000000000002", provider_method_id: "debvisa", display_name: "Visa Débito", provider_payment_types: ["debit_card"] }),
      row({ id: "00000000-0000-4000-8000-000000000003", provider_method_id: "master", display_name: "Mastercard", provider_payment_types: ["credit_card"], image_path: null }),
    ],
    (path) => `https://cdn.test/${path}`,
  )
  assert.deepEqual(getCheckoutCashLogoGroups(logos).map((group) => group.id), ["credit", "debit"])
  assert.equal(findCreditLogo(logos, "visa")?.name, "Visa")
  assert.equal(findCreditLogo(logos, "master"), null, "sin imagen no hay logo")
  assert.equal(findCreditLogo(logos, "debvisa"), null, "débito no es una marca de cuotas")
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const encode = (text: string) => new TextEncoder().encode(text)

test("imágenes: PNG y SVG válidos; firma, tamaño y formato validados server-side", () => {
  assert.deepEqual(validatePaymentLogoUpload(PNG, "image/png"), { ok: true, format: "png", contentType: "image/png" })
  const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg>'
  assert.deepEqual(validatePaymentLogoUpload(encode(svg), "image/svg+xml"), { ok: true, format: "svg", contentType: "image/svg+xml" })
  assert.equal(validatePaymentLogoUpload(encode("<html>no</html>"), "image/png").ok, false, "MIME falsificado")
  assert.equal(validatePaymentLogoUpload(PNG, "image/gif").ok, false)
  assert.equal(validatePaymentLogoUpload(new Uint8Array(), "image/png").ok, false)
  const big = new Uint8Array(1024 * 1024 + 1)
  big.set(PNG)
  assert.equal(validatePaymentLogoUpload(big, "image/png").ok, false)
})

test("SVG peligrosos se rechazan (scripts, eventos, contenido o referencias externas)", () => {
  const wrap = (inner: string, attrs = "") => `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`
  for (const svg of [
    wrap("<script>alert(1)</script>"),
    wrap("", ' onload="alert(1)"'),
    wrap('<a href="javascript:alert(1)"><rect/></a>'),
    wrap('<image href="https://evil.test/x.png"/>'),
    wrap('<image xlink:href="data:image/png;base64,AAAA"/>'),
    wrap("<foreignObject><div/></foreignObject>"),
    wrap('<rect style="fill:url(https://evil.test/x)"/>'),
    wrap("<style>@import url(https://evil.test/x.css);</style>"),
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    "<div>no es svg</div>",
  ]) {
    assert.notEqual(getSvgSafetyError(svg), null, svg)
  }
  assert.equal(validatePaymentLogoUpload(new Uint8Array([0xff, 0xfe, 0x3c]), "image/svg+xml").ok, false, "UTF-8 inválido")
})

test("nombres de medios manuales: Unicode español permitido, controles y HTML no", () => {
  assert.equal(normalizePaymentMethodName("  Cuenta   DNI – Bancos Ñandú  "), "Cuenta DNI – Bancos Ñandú")
  assert.equal(normalizePaymentMethodName("MODO"), "MODO")
  assert.equal(normalizePaymentMethodName("<b>x</b>"), null)
  assert.equal(normalizePaymentMethodName("a\u0000b"), null)
  assert.equal(normalizePaymentMethodName(""), null)
  assert.equal(normalizePaymentMethodName("x".repeat(81)), null)
  assert.equal(normalizePaymentMethodName(42), null)
})

test("migración: RLS sin acceso anon/authenticated, unicidad por id de Mercado Pago y bucket propio acotado", () => {
  const sql = readFileSync("supabase/migrations/20261006100000_payment_method_logos.sql", "utf8")
  assert.match(sql, /alter table public\.payment_method_logos enable row level security/)
  assert.match(sql, /revoke all on table public\.payment_method_logos from anon, authenticated/)
  assert.doesNotMatch(sql, /create policy/i, "sólo el servidor (service_role) lee y escribe")
  assert.match(sql, /constraint payment_method_logos_provider_unique unique \(source, provider_method_id\)/)
  assert.match(sql, /'payment-method-logos',\s*'payment-method-logos',\s*true,\s*1048576,\s*array\['image\/png', 'image\/svg\+xml', 'image\/webp', 'image\/jpeg'\]/)
  assert.doesNotMatch(sql, /\b(drop|truncate)\b|delete\s+from/i, "migración aditiva")
})