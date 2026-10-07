import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

// Producción: VPS + PM2 (127.0.0.1:3000) y timers systemd. Todo job que llama
// a /api/cron/* debe leer CRON_SECRET de un archivo privado de curl (--config),
// nunca en argv (ps, /proc/<pid>/cmdline) ni en el repo.
const DIR = new URL("../../deploy/systemd/", import.meta.url)
const units = readdirSync(DIR).filter((name) => name.endsWith(".service"))

function directives(name: string) {
  return readFileSync(new URL(name, DIR), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
}

test("hay unidades systemd para todos los jobs programados de producción", () => {
  for (const job of [
    "andreani-sync-tracking",
    "arca-invoices",
    "cleanup-claim-uploads",
    "expire-mercadopago-orders",
    "expire-transfer-orders",
    "reconcile-mercadopago-refunds",
    "verify-transfer-orders",
  ]) {
    assert.ok(units.includes(`beyonix-${job}.service`), job)
    assert.match(readFileSync(new URL(`beyonix-${job}.timer`, DIR), "utf8"), new RegExp(`^Unit=beyonix-${job}\\.service$`, "m"))
  }
})

for (const name of units) {
  test(`${name}: secreto fuera de argv, flock y loopback`, () => {
    const unit = directives(name)
    const job = name.replace(/^beyonix-|\.service$/g, "")
    assert.doesNotMatch(unit, /\$\{?CRON_SECRET|Authorization:|Bearer|EnvironmentFile|cron\.env/i)
    assert.match(unit, /--config \/etc\/beyonix\/curl-verify-transfer-orders\.conf/)
    assert.match(unit, new RegExp(`^ExecStart=/usr/bin/flock -n /run/lock/beyonix-${job}\\.lock`, "m"))
    assert.match(unit, new RegExp(`http://127\\.0\\.0\\.1:3000/api/cron/${job}\\b`))
    assert.match(unit, /--fail/)
    assert.match(unit, /-o \/dev\/null/)
    assert.doesNotMatch(unit, /^User=(?!root$)/m, "el archivo de curl es root:root 600")
  })
}

test("frecuencias de los jobs migrados sin cambios", () => {
  const calendar = (job: string) => readFileSync(new URL(`beyonix-${job}.timer`, DIR), "utf8").match(/^OnCalendar=(.+)$/m)?.[1]
  assert.equal(calendar("andreani-sync-tracking"), "*:0/15")
  assert.equal(calendar("expire-mercadopago-orders"), "*:0/15")
  assert.equal(calendar("expire-transfer-orders"), "*:0/15")
  assert.equal(calendar("reconcile-mercadopago-refunds"), "*:0/5")
  assert.equal(calendar("cleanup-claim-uploads"), "*-*-* 04:15:00")
})
