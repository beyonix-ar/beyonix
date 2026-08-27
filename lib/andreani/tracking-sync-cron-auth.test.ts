import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import netlifyHandler, {
  config as netlifyConfig,
} from "../../netlify/functions/andreani-sync-tracking.mts"
import { isAndreaniTrackingCronAuthorized } from "./tracking-sync-cron-auth.ts"

const TEST_CRON_SECRET = "cron-secret-de-prueba"

test("el cron Andreani permite el secret correcto", () => {
  assert.equal(
    isAndreaniTrackingCronAuthorized(
      `Bearer ${TEST_CRON_SECRET}`,
      TEST_CRON_SECRET,
    ),
    true,
  )
})

test("el cron Andreani rechaza un secret incorrecto", () => {
  assert.equal(
    isAndreaniTrackingCronAuthorized(
      "Bearer secret-incorrecto",
      TEST_CRON_SECRET,
    ),
    false,
  )
})

test("el cron Andreani rechaza CRON_SECRET ausente", () => {
  assert.equal(
    isAndreaniTrackingCronAuthorized(`Bearer ${TEST_CRON_SECRET}`, undefined),
    false,
  )
})

test("el cron Andreani rechaza CRON_SECRET vacío o compuesto sólo por espacios", () => {
  assert.equal(isAndreaniTrackingCronAuthorized("Bearer ", ""), false)
  assert.equal(isAndreaniTrackingCronAuthorized("Bearer ", "   "), false)
})

test("la ruta rechaza antes de ejecutar el batch de tracking", () => {
  const source = readFileSync(
    new URL(
      "../../app/api/cron/andreani-sync-tracking/route.ts",
      import.meta.url,
    ),
    "utf8",
  )
  const guard = source.match(
    /if\s*\(\s*!isAndreaniTrackingCronAuthorized\([\s\S]*?\)\s*\)\s*\{([\s\S]*?)\n\s*\}/,
  )
  const batchCallIndex = source.indexOf(
    "runAndreaniTrackingSyncBatch(createAdminClient())",
  )

  assert.ok(guard?.index !== undefined, "Falta el guard de autorización")
  assert.match(guard[1], /return NextResponse\.json\([\s\S]*status: 401/)
  assert.ok(batchCallIndex > guard.index, "El batch debe ejecutarse después del guard")
})

test("la Scheduled Function de Netlify conserva el Bearer y la frecuencia de 15 minutos", async () => {
  const previousCronSecret = process.env.CRON_SECRET
  const previousUrl = process.env.URL
  const previousFetch = globalThis.fetch
  let receivedAuthorization: string | null = null

  process.env.CRON_SECRET = TEST_CRON_SECRET
  process.env.URL = "https://beyonix.test"
  globalThis.fetch = async (input, init) => {
    assert.equal(
      String(input),
      "https://beyonix.test/api/cron/andreani-sync-tracking",
    )
    receivedAuthorization = new Headers(init?.headers).get("authorization")
    return Response.json({
      ok: true,
      checked: 0,
      updated: 0,
      statusChanged: 0,
      errors: 0,
    })
  }

  try {
    const response = await netlifyHandler()

    assert.equal(response.status, 200)
    assert.equal(receivedAuthorization, `Bearer ${TEST_CRON_SECRET}`)
    assert.equal(netlifyConfig.schedule, "*/15 * * * *")
  } finally {
    globalThis.fetch = previousFetch

    if (previousCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previousCronSecret

    if (previousUrl === undefined) delete process.env.URL
    else process.env.URL = previousUrl
  }
})
