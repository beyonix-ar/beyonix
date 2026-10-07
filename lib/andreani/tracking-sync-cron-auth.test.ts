import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

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
  const adminIndex = source.indexOf("const admin = createAdminClient()")
  const batchCallIndex = source.indexOf("runAndreaniTrackingSyncBatch(admin)")
  const returnsBatchIndex = source.indexOf("runClaimShipmentTrackingBatch(admin)")

  assert.ok(guard?.index !== undefined, "Falta el guard de autorización")
  assert.match(guard[1], /return NextResponse\.json\([\s\S]*status: 401/)
  assert.ok(adminIndex > guard.index, "El cliente admin se crea después del guard")
  assert.ok(batchCallIndex > guard.index, "El batch debe ejecutarse después del guard")
  assert.ok(returnsBatchIndex > guard.index, "El batch de devoluciones también")
})

// Producción corre en la VPS (PM2 + systemd), no en Netlify: el único
// scheduler del tracking es el timer del repo, instalado en /etc/systemd/system.
test("el timer systemd del tracking corre cada 15 minutos por loopback, sin el secreto en argv", () => {
  const read = (name: string) => readFileSync(new URL(`../../deploy/systemd/${name}`, import.meta.url), "utf8")
  const service = read("beyonix-andreani-sync-tracking.service")
  const timer = read("beyonix-andreani-sync-tracking.timer")

  const execStart = service.slice(service.indexOf("ExecStart="))
  assert.match(execStart, /^ExecStart=\/usr\/bin\/flock -n \/run\/lock\/beyonix-andreani-sync-tracking\.lock/)
  assert.match(execStart, /--config \/etc\/beyonix\/curl-verify-transfer-orders\.conf/)
  assert.match(execStart, /--fail/)
  assert.match(execStart, /http:\/\/127\.0\.0\.1:3000\/api\/cron\/andreani-sync-tracking/)
  assert.doesNotMatch(service, /\$\{?CRON_SECRET|Authorization: Bearer|EnvironmentFile/, "el secreto nunca en argv ni en el repo")
  assert.match(timer, /^OnCalendar=\*:0\/15$/m)
  assert.match(timer, /^Persistent=true$/m)
  assert.match(timer, /^Unit=beyonix-andreani-sync-tracking\.service$/m)
})

test("no queda ningún scheduler de Netlify en el repo", () => {
  assert.throws(
    () => readFileSync(new URL("../../netlify/functions/andreani-sync-tracking.mts", import.meta.url)),
    /ENOENT/,
  )
})
