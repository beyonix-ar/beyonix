import assert from "node:assert/strict"
import test from "node:test"

import {
  bannerInclusiveEndParts,
  bannerInclusiveEndToUtc,
  bannerStartParts,
  bannerStartToUtc,
  compareBannerPriority,
  BANNER_SORT_ORDER_MAX,
  BANNER_SORT_ORDER_MIN,
  detectBannerImageMime,
  isBannerMimeAllowed,
  parseBannerSortOrder,
  parseBannerVersion,
  getBannerStatus,
  pickVisibleBanner,
  validateBannerDestination,
  validateBannerImageUrl,
} from "./site-banners.ts"
import {
  HOME_CAMPAIGN_CHANGE_MARGIN_MS,
  HOME_CAMPAIGN_POLL_MS,
  msUntilHomeCampaignEnds,
  isHomeCampaignStale,
  msUntilHomeCampaignRefresh,
} from "./home-campaign-schedule.ts"
import { parseHomeCampaignState } from "./public-banners.ts"

const SUPABASE = "https://proyecto.supabase.co"
const BUCKET = `${SUPABASE}/storage/v1/object/public/site-banners/`

test("estado calculado: Desactivada, Programada, Activa, Finalizada; inicio inclusivo y fin exclusivo", () => {
  const startsAt = "2026-12-20T12:00:00.000Z"
  const endsAt = "2026-12-27T03:00:00.000Z"
  const at = (iso: string) => Date.parse(iso)
  assert.equal(getBannerStatus({ active: false, starts_at: startsAt, ends_at: endsAt }, at("2026-12-22T00:00:00Z")), "disabled")
  assert.equal(getBannerStatus({ active: true, starts_at: startsAt, ends_at: endsAt }, at(startsAt) - 1), "scheduled")
  assert.equal(getBannerStatus({ active: true, starts_at: startsAt, ends_at: endsAt }, at(startsAt)), "active", "el inicio es inclusivo")
  assert.equal(getBannerStatus({ active: true, starts_at: startsAt, ends_at: endsAt }, at(endsAt) - 1), "active")
  assert.equal(getBannerStatus({ active: true, starts_at: startsAt, ends_at: endsAt }, at(endsAt)), "ended", "el fin es exclusivo")
  assert.equal(getBannerStatus({ active: true }, 0), "active", "sin fechas: permanente")
  assert.equal(getBannerStatus({ active: true, starts_at: null, ends_at: endsAt }, at(endsAt) + 1), "ended")
})

test("'visible hasta el 26/12 23:59' se guarda como 27/12 00:00 en Argentina (UTC) y vuelve igual al formulario", () => {
  const end = bannerInclusiveEndToUtc("2026-12-26", "23:59")
  assert.equal(end, "2026-12-27T03:00:00.000Z")
  assert.deepEqual(bannerInclusiveEndParts(end), { date: "2026-12-26", time: "23:59" })
  const start = bannerStartToUtc("2026-12-20", "09:00")
  assert.equal(start, "2026-12-20T12:00:00.000Z")
  assert.deepEqual(bannerStartParts(start), { date: "2026-12-20", time: "09:00" })
  assert.equal(bannerInclusiveEndToUtc("2026-02-30", "10:00"), null, "fecha inexistente")
  assert.equal(bannerStartToUtc("2026-12-20", "24:00"), null)
  // 23:59:59.999 del 26/12 sigue visible; 00:00 del 27/12 ya no.
  assert.equal(getBannerStatus({ active: true, ends_at: end }, Date.parse("2026-12-27T02:59:59.999Z")), "active")
  assert.equal(getBannerStatus({ active: true, ends_at: end }, Date.parse("2026-12-27T03:00:00.000Z")), "ended")
})

test("prioridad estable: menor orden, después la más antigua y el id; una permanente actúa de alternativa", () => {
  const now = Date.parse("2026-12-24T15:00:00Z")
  const banners = [
    { id: "c", sort_order: 1, created_at: "2026-11-01T00:00:00Z", active: true },
    { id: "b", sort_order: 0, created_at: "2026-11-02T00:00:00Z", active: true, starts_at: "2026-12-20T00:00:00Z", ends_at: "2026-12-26T00:00:00Z" },
    { id: "a", sort_order: 0, created_at: "2026-11-02T00:00:00Z", active: true, starts_at: "2026-12-20T00:00:00Z", ends_at: "2026-12-26T00:00:00Z" },
    { id: "future", sort_order: -5, created_at: "2026-11-01T00:00:00Z", active: true, starts_at: "2027-01-01T00:00:00Z" },
    { id: "off", sort_order: -9, created_at: "2026-11-01T00:00:00Z", active: false },
  ]
  assert.equal(pickVisibleBanner(banners, now)?.id, "a", "empate total: id")
  assert.equal(pickVisibleBanner(banners, Date.parse("2026-12-27T00:00:00Z"))?.id, "c", "vencida la de Navidad, queda la permanente")
  assert.equal(pickVisibleBanner(banners, Date.parse("2027-01-01T00:00:00Z"))?.id, "future", "empieza la de mayor prioridad")
  assert.equal(pickVisibleBanner([], now), null)
  assert.ok(compareBannerPriority({ id: "x", sort_order: 0, created_at: "2026-01-01T00:00:00Z" }, { id: "a", sort_order: 0, created_at: "2026-02-01T00:00:00Z" }) < 0)
})

test("enlaces: rutas internas y https admitidos; javascript:, data:, http:, //host, barras invertidas y mal formados, no", () => {
  assert.deepEqual(validateBannerDestination(""), { ok: true, value: null })
  assert.deepEqual(validateBannerDestination(" /productos?categoria=audio#ofertas "), { ok: true, value: "/productos?categoria=audio#ofertas" })
  assert.deepEqual(validateBannerDestination("https://www.instagram.com/beyonix"), { ok: true, value: "https://www.instagram.com/beyonix" })
  for (const value of [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x",
    "http://beyonix.com.ar/", "//evil.example/x", "/\\evil.example", "https://evil.example/", "https://beyonix.com.ar.evil.example/",
    "https://user:pass@beyonix.com.ar/", "https://beyonix.com.ar:8443/", "/productos con espacio", "https://", "ftp://beyonix.com.ar/",
    "/\u0000x", "x".repeat(3000),
  ]) {
    assert.equal(validateBannerDestination(value).ok, false, value)
  }
})

test("imágenes: el Home sólo admite el bucket propio; Productos conserva URLs externas pero sólo http(s)", () => {
  assert.deepEqual(validateBannerImageUrl(`${BUCKET}home/1-navidad.webp`, "home", SUPABASE), { ok: true, value: `${BUCKET}home/1-navidad.webp`, storagePath: "home/1-navidad.webp" })
  for (const url of [
    "https://img.example/banner.jpg", `${SUPABASE}/storage/v1/object/public/otro-bucket/x.jpg`, `${BUCKET}../secreto.png`,
    `${BUCKET}home/x.png?download=1`, `${BUCKET}`, "javascript:alert(1)", `${BUCKET}home/%2e%2e/x.png`,
  ]) {
    assert.equal(validateBannerImageUrl(url, "home", SUPABASE).ok, false, url)
  }
  assert.equal(validateBannerImageUrl("https://img.example/banner.jpg", "products", SUPABASE).ok, true, "Productos: como antes")
  assert.equal(validateBannerImageUrl(`${BUCKET}products/1.jpg`, "products", SUPABASE).ok, true)
  for (const url of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "notaurl", ""]) {
    assert.equal(validateBannerImageUrl(url, "products", SUPABASE).ok, false, url)
  }
})

test("formatos por ubicación: Home sólo JPG/PNG/WebP/AVIF; Productos conserva GIF; SVG en ninguna", () => {
  const text = (value: string) => new TextEncoder().encode(value)
  const gif = detectBannerImageMime(text("GIF89a\u0001\u0000\u0001\u0000"))
  assert.equal(gif, "image/gif")
  assert.equal(detectBannerImageMime(text("GIF87a\u0001\u0000")), "image/gif")
  assert.equal(isBannerMimeAllowed(gif, "products"), true, "Productos: como antes")
  assert.equal(isBannerMimeAllowed(gif, "home"), false, "Home: no")
  for (const mime of ["image/jpeg", "image/png", "image/webp", "image/avif"] as const) {
    assert.equal(isBannerMimeAllowed(mime, "home"), true, mime)
    assert.equal(isBannerMimeAllowed(mime, "products"), true, mime)
  }
  const svg = detectBannerImageMime(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))
  assert.equal(isBannerMimeAllowed(svg, "products"), false)
  assert.equal(isBannerMimeAllowed(svg, "home"), false)
})

test("prioridad: sólo enteros dentro del rango; vacío, texto, decimales o fuera de rango se rechazan (nunca 0 en silencio)", () => {
  for (const [input, value] of [["0", 0], [" 3 ", 3], ["-1", -1], [12, 12], ["999", BANNER_SORT_ORDER_MAX], ["-999", BANNER_SORT_ORDER_MIN], ["-0", 0], ["007", 7]] as const) {
    assert.deepEqual(parseBannerSortOrder(input), { ok: true, value }, String(input))
  }
  for (const input of ["", "   ", "abc", "1.5", "1,5", "1e3", "1000", "-1000", "+2", "2 3", "0x10", "Infinity", "NaN", null, undefined, 1.5, Number.NaN, 1e6, true, {}]) {
    const result = parseBannerSortOrder(input)
    assert.equal(result.ok, false, String(input))
    if (!result.ok) assert.match(result.error, /número entero entre -999 y 999/)
  }
})

test("tipo real por firma: JPG, PNG, WebP y AVIF sí; SVG, HTML y vacíos no", () => {
  const bytes = (...values: number[]) => new Uint8Array(values)
  const text = (value: string) => new TextEncoder().encode(value)
  assert.equal(detectBannerImageMime(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg")
  assert.equal(detectBannerImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png")
  assert.equal(detectBannerImageMime(text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")), "image/webp")
  assert.equal(detectBannerImageMime(bytes(0, 0, 0, 0x1c, ...text("ftypavif"), 0, 0, 0, 0, ...text("avifmif1miaf"))), "image/avif")
  assert.equal(detectBannerImageMime(bytes(0, 0, 0, 0x18, ...text("ftypmif1"), 0, 0, 0, 0, ...text("mif1avif"))), "image/avif", "marca compatible")
  assert.equal(detectBannerImageMime(bytes(0, 0, 0, 0x18, ...text("ftypisom"), 0, 0, 0, 0, ...text("isommp41"))), null, "MP4 no es imagen")
  for (const value of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "GIF8", "<!doctype html>", ""]) {
    assert.equal(detectBannerImageMime(text(value)), null, value)
  }
})

test("Home con la página abierta: consulta en el próximo cambio (hora del servidor) o, a más tardar, en la revisión periódica corta", () => {
  const serverNow = "2026-12-26T23:00:00.000Z"
  assert.equal(HOME_CAMPAIGN_POLL_MS, 60_000, "una campaña desactivada desaparece en a lo sumo 1 minuto")
  assert.equal(msUntilHomeCampaignRefresh({ serverNow, nextChangeAt: "2026-12-26T23:00:20.000Z" }), 20_000 + HOME_CAMPAIGN_CHANGE_MARGIN_MS, "límite programado antes de la revisión")
  assert.equal(msUntilHomeCampaignRefresh({ serverNow, nextChangeAt: "2026-12-26T22:00:00.000Z" }), HOME_CAMPAIGN_CHANGE_MARGIN_MS, "ya pasó: enseguida")
  assert.equal(msUntilHomeCampaignRefresh({ serverNow, nextChangeAt: null }), HOME_CAMPAIGN_POLL_MS, "permanente: revisión periódica")
  assert.equal(msUntilHomeCampaignRefresh({ serverNow, nextChangeAt: "2026-12-27T03:00:00.000Z" }), HOME_CAMPAIGN_POLL_MS, "límite lejano: no espera horas")
  assert.equal(isHomeCampaignStale({ serverNow }, Date.parse(serverNow) + 30_000), false)
  assert.equal(isHomeCampaignStale({ serverNow }, Date.parse(serverNow) + 10 * 60_000), true, "render viejo")
  assert.equal(isHomeCampaignStale({ serverNow: "x" }, 0), true)
  const banner = { id: "a", placement: "home" as const, image_url: `${BUCKET}a.jpg`, mobile_image_url: null, alt_text: null, destination_url: null, active: true, sort_order: 0, ends_at: "2026-12-27T03:00:00.000Z", updated_at: null }
  assert.equal(msUntilHomeCampaignEnds({ banner, serverNow }), 4 * 3_600_000)
  assert.equal(msUntilHomeCampaignEnds({ banner, serverNow: "2026-12-27T04:00:00.000Z" }), 0, "ya terminó")
  assert.equal(msUntilHomeCampaignEnds({ banner: { ...banner, ends_at: null }, serverNow }), null, "permanente")
  assert.equal(msUntilHomeCampaignEnds({ banner: null, serverNow }), null)
})

test("respuesta pública del Home validada en el navegador", () => {
  const banner = { id: "a", placement: "home", image_url: `${BUCKET}a.jpg`, mobile_image_url: null, alt_text: "Navidad", destination_url: "/productos", active: true, sort_order: 0, ends_at: null, updated_at: null }
  assert.equal(parseHomeCampaignState({ banner, nextChangeAt: null, serverNow: "2026-12-24T12:00:00Z" })?.banner?.id, "a")
  assert.equal(parseHomeCampaignState({ banner: { ...banner, placement: "products" }, nextChangeAt: null, serverNow: "2026-12-24T12:00:00Z" })?.banner, null)
  assert.equal(parseHomeCampaignState({ banner: null, serverNow: "nope" }), null)
  assert.equal(parseHomeCampaignState("<html>"), null)
})

test("versión del banner (expected_updated_at): sólo ISO 8601 completo con zona; se devuelve sin reformatear", () => {
  for (const valid of [
    "2026-11-23T12:00:00Z",
    "2026-11-23T12:00:00.000Z",
    "2026-11-23T12:00:00.123456+00:00",
    "2026-11-23T09:00:00.5-03:00",
    "2026-11-23T17:30:00+05:30",
    "2028-02-29T00:00:00+00:00",
  ]) {
    assert.equal(parseBannerVersion(valid), valid, valid)
  }
  assert.equal(parseBannerVersion(" 2026-11-23T12:00:00Z "), "2026-11-23T12:00:00Z", "sólo recorta espacios")
  for (const invalid of [
    undefined, null, 0, 1700000000000, "", "   ", "0", "1", "ayer", "null", "now", "abc 2026",
    "2026", "2026-11-23", "2026-11-23T12:00", "2026-11-23T12:00:00", "2026-11-23 12:00:00+00:00", "Mon, 23 Nov 2026 12:00:00 GMT",
    "2026-02-30T00:00:00Z", "2027-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-11-00T00:00:00Z",
    "2026-11-23T24:00:00Z", "2026-11-23T12:60:00Z", "2026-11-23T12:00:60Z", "2026-11-23T12:00:00.1234567Z",
    "2026-11-23T12:00:00+16:00", "2026-11-23T12:00:00+05:60", "2026-11-23T12:00:00+0000", "0000-01-01T00:00:00Z",
    "2026-11-23T12:00:00Z'; drop table x; --",
  ]) {
    assert.equal(parseBannerVersion(invalid), null, String(invalid))
  }
})
