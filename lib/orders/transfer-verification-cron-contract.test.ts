import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const routeSource = readFileSync(
  new URL(
    "../../app/api/cron/verify-transfer-orders/route.ts",
    import.meta.url,
  ),
  "utf8",
)

test("el cron de reintentos de transferencias exige CRON_SECRET antes de correr el batch (falla cerrado)", () => {
  const guard = routeSource.match(
    /if\s*\(\s*![\s\S]*?isCronRequestAuthorized\([\s\S]*?\)\s*\)\s*\{([\s\S]*?)\n\s*\}/,
  )
  const batchCallIndex = routeSource.indexOf(
    "retryPendingTransferVerifications(createAdminClient())",
  )

  assert.ok(guard?.index !== undefined, "Falta el guard de autorización")
  assert.match(guard![1], /return NextResponse\.json\([\s\S]*status: 401/)
  assert.ok(batchCallIndex > guard!.index!, "El batch debe ejecutarse después del guard")
})

test("el cron de reintentos de transferencias corre separado del cron de expiración y del de refunds de Mercado Pago", () => {
  assert.doesNotMatch(routeSource, /expireOverdueTransferOrders/)
  assert.doesNotMatch(routeSource, /mercadopago/i)
})

test("vercel.json NO registra el cron de transferencias (BEYONIX no corre en Vercel, producción es una VPS con systemd timer)", () => {
  const vercelConfig = JSON.parse(
    readFileSync(new URL("../../vercel.json", import.meta.url), "utf8"),
  ) as { crons: Array<{ path: string; schedule: string }> }

  const entry = vercelConfig.crons.find(
    (cron) => cron.path === "/api/cron/verify-transfer-orders",
  )

  assert.equal(entry, undefined)
})

test("el endpoint no depende de ningún mecanismo específico de Vercel (sólo lee CRON_SECRET del entorno del proceso)", () => {
  assert.doesNotMatch(routeSource, /vercel/i)
  assert.doesNotMatch(routeSource, /@vercel/i)
})

const serviceUnit = readFileSync(
  new URL(
    "../../deploy/systemd/beyonix-verify-transfer-orders.service",
    import.meta.url,
  ),
  "utf8",
)

test("el timer de systemd llama al endpoint GET por loopback", () => {
  assert.match(serviceUnit, /http:\/\/127\.0\.0\.1:3000\/api\/cron\/verify-transfer-orders/)
})

// P1 corregido en esta auditoría: `-H "Authorization: Bearer ${CRON_SECRET}"`
// dentro de ExecStart hace que systemd expanda la variable ANTES de ejecutar
// curl -- el valor real queda en el argv del proceso (ps aux,
// /proc/<pid>/cmdline) mientras corre. El fix usa `curl --config` apuntando a
// un archivo fuera del repo (permisos 600), que curl lee internamente sin
// exponer el header en su línea de comandos.
test("el secreto NUNCA viaja como argumento de curl -- ni interpolado en ExecStart, ni vía EnvironmentFile expandido ahí", () => {
  // El nombre de la variable puede mencionarse en comentarios explicando el
  // porqué del fix -- lo que nunca puede pasar es que el comando real
  // (ExecStart=) la referencie o expanda.
  const execStart = serviceUnit.slice(serviceUnit.indexOf("ExecStart="))
  assert.doesNotMatch(execStart, /CRON_SECRET/)
  assert.doesNotMatch(execStart, /-H\s+["']Authorization/)
  assert.doesNotMatch(serviceUnit, /^EnvironmentFile=/m)
})

test("el header de autorización se lee desde un archivo de configuración de curl fuera del repo, nunca hardcodeado en el .service", () => {
  const execStart = serviceUnit.slice(serviceUnit.indexOf("ExecStart="))
  assert.match(execStart, /--config \/etc\/beyonix\/curl-verify-transfer-orders\.conf/)
  assert.doesNotMatch(execStart, /Bearer\s+\S/)
})

test("ningún archivo bajo deploy/systemd/ contiene un secreto en texto plano", () => {
  const timerUnit = readFileSync(
    new URL(
      "../../deploy/systemd/beyonix-verify-transfer-orders.timer",
      import.meta.url,
    ),
    "utf8",
  )
  const readmeSource = readFileSync(
    new URL("../../deploy/systemd/README.md", import.meta.url),
    "utf8",
  )

  for (const source of [serviceUnit, timerUnit, readmeSource]) {
    // El README documenta el placeholder explícito a reemplazar en la VPS --
    // no es un secreto real, así que se excluye antes de buscar cualquier
    // otro valor que sí pudiera serlo.
    const withoutPlaceholder = source.replaceAll(
      "REEMPLAZAR_CON_EL_CRON_SECRET_REAL",
      "",
    )
    assert.doesNotMatch(withoutPlaceholder, /Bearer\s+[A-Za-z0-9._-]{16,}/)
  }
})

const execStartBlock = serviceUnit.slice(serviceUnit.indexOf("ExecStart="))

test("el resultado SUCCESS/FAILURE se puede leer sin exponer datos sensibles: la respuesta del endpoint se descarta y no se logueó texto libre", () => {
  assert.match(execStartBlock, /--fail/)
  assert.match(execStartBlock, /-o \/dev\/null/)
  assert.match(execStartBlock, /--show-error/)
})

test("timeout razonable y sin reintentos agresivos (curl nunca usa --retry)", () => {
  assert.match(execStartBlock, /--max-time \d+/)
  assert.doesNotMatch(execStartBlock, /--retry/)
})

test("nunca pueden superponerse dos corridas del mismo job (flock no bloqueante sobre un lock dedicado)", () => {
  assert.match(execStartBlock, /flock -n \/run\/lock\/beyonix-verify-transfer-orders\.lock/)
})

test("el timer corre aproximadamente cada 15 minutos, igual cadencia que el resto de los crons de BEYONIX", () => {
  const timerUnit = readFileSync(
    new URL(
      "../../deploy/systemd/beyonix-verify-transfer-orders.timer",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(timerUnit, /OnUnitActiveSec=15min/)
  assert.match(timerUnit, /Unit=beyonix-verify-transfer-orders\.service/)
})
