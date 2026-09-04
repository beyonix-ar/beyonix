import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { isCronRequestAuthorized } from "./cron-auth.ts"

const SECRET = "cron-secret-de-prueba"

test("acepta únicamente el Bearer exacto del secret configurado", () => {
  assert.equal(isCronRequestAuthorized(`Bearer ${SECRET}`, SECRET), true)
  assert.equal(isCronRequestAuthorized("Bearer otro-secret", SECRET), false)
  assert.equal(isCronRequestAuthorized(SECRET, SECRET), false)
  assert.equal(isCronRequestAuthorized(null, SECRET), false)
})

test("falla CERRADO cuando CRON_SECRET no está configurado", () => {
  assert.equal(isCronRequestAuthorized(`Bearer ${SECRET}`, undefined), false)
  assert.equal(isCronRequestAuthorized(`Bearer ${SECRET}`, ""), false)
  assert.equal(isCronRequestAuthorized(`Bearer ${SECRET}`, "   "), false)
  assert.equal(isCronRequestAuthorized("Bearer ", undefined), false)
})

test("ningún endpoint de cron queda abierto cuando falta el secret", () => {
  const cronRoutes = [
    "app/api/cron/expire-transfer-orders/route.ts",
    "app/api/cron/expire-mercadopago-orders/route.ts",
    "app/api/cron/andreani-sync-tracking/route.ts",
  ]

  for (const route of cronRoutes) {
    const source = readFileSync(route, "utf8")
    // El patrón peligroso es autorizar sólo "si hay secret configurado":
    // sin variable, la guarda entera se saltea y el endpoint queda público.
    assert.doesNotMatch(
      source,
      /if \(cronSecret && /,
      `${route} sólo valida el secret cuando existe`,
    )
    assert.match(
      source,
      /isCronRequestAuthorized|isAndreaniTrackingCronAuthorized|if \(!cronSecret\)/,
      `${route} no falla cerrado`,
    )
  }
})
