import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import {
  arcaConfigurationErrorResponse,
  getArcaConfigurationStatus,
  inspectArcaConfiguration,
  requireArcaConfiguration,
  type ArcaConfiguration,
} from "./configuration.ts"
import {
  arcaCertificateLabel,
  arcaEnvironmentLabel,
  getArcaIssueBlockReason,
} from "./configuration-view.ts"
import { ArcaConfigurationError } from "./environment.ts"
import {
  TEST_CUIT,
  arcaTestEnv,
  createArcaTestCredentials,
  createTestKeyPem,
} from "./fixtures/arca-test-certificates.ts"
import { runArcaConnectivityDiagnostics, type ArcaDiagnosticsDependencies } from "./production-diagnostics.ts"
import { buildFiscalArcaQrUrl } from "./qr.ts"

// Fail-closed de ARCA: sin configuración explícita y coherente no se
// autentica ni se emite. Sin red: ningún test contacta a ARCA.

const DAY_MS = 24 * 60 * 60 * 1000
const homologationCredentials = createArcaTestCredentials({ issuerCn: "Computadores Test" })
const productionCredentials = createArcaTestCredentials({ issuerCn: "Computadores" })
const homologationEnv = arcaTestEnv("homologation", {}, homologationCredentials)
const productionEnv = arcaTestEnv("production", {}, productionCredentials)

function configurationErrors(env: Record<string, string | undefined>, now?: Date) {
  try {
    requireArcaConfiguration(env, now)
  } catch (error) {
    assert.ok(error instanceof ArcaConfigurationError, "siempre ArcaConfigurationError")
    return error.errors
  }
  assert.fail("La configuración debía rechazarse.")
}

test("ARCA_ENV ausente, vacío o inválido: error de configuración, nunca homologación por defecto", () => {
  for (const value of [undefined, "", "   ", "prod", "Production", "PRODUCTION", "homologacion", "test", "sandbox"]) {
    const errors = configurationErrors({ ...homologationEnv, ARCA_ENV: value })
    assert.ok(errors.some((error) => /ARCA_ENV/.test(error)), `ARCA_ENV=${JSON.stringify(value)}`)
    const status = getArcaConfigurationStatus({ ...homologationEnv, ARCA_ENV: value })
    assert.equal(status.configured, false)
    assert.equal(status.environment, null, "nunca se infiere un ambiente")
  }
})

test("homologation + certificado de homologación: configurado, sin validez fiscal", () => {
  const configuration = requireArcaConfiguration(homologationEnv)
  assert.equal(configuration.environment, "homologation")
  assert.equal(configuration.pointOfSale, 1)
  const status = getArcaConfigurationStatus(homologationEnv)
  assert.deepEqual(
    { ...status, certificateExpiresAt: typeof status.certificateExpiresAt },
    {
      configured: true,
      environment: "homologation",
      certificateType: "homologation",
      certificateExpiresAt: "string",
      cuitMatches: true,
      privateKeyMatches: true,
      pointOfSale: 1,
      pointOfSaleConfigured: true,
      autoInvoicingEnabled: false,
      errors: [],
    },
  )
})

test("production + certificado de producción: configurado", () => {
  const configuration = requireArcaConfiguration(productionEnv)
  assert.equal(configuration.environment, "production")
  assert.equal(getArcaConfigurationStatus(productionEnv).certificateType, "production")
})

test("production nunca acepta un certificado de homologación (Computadores Test)", () => {
  const errors = configurationErrors({ ...homologationEnv, ARCA_ENV: "production" })
  assert.ok(errors.some((error) => /ARCA_ENV=production no admite un certificado de homologación/.test(error)))
})

test("homologation nunca firma con el certificado de producción", () => {
  const errors = configurationErrors({ ...productionEnv, ARCA_ENV: "homologation" })
  assert.ok(errors.some((error) => /ARCA_ENV=homologation no admite el certificado de producción/.test(error)))
})

test("certificado de una CA ajena a ARCA: rechazado", () => {
  const foreign = createArcaTestCredentials({ issuerCn: "Otra CA" })
  const errors = configurationErrors(arcaTestEnv("production", {}, foreign))
  assert.ok(errors.some((error) => /no fue emitido por una CA de ARCA/.test(error)))
})

test("CUIT del certificado distinto de ARCA_CUIT: rechazado", () => {
  const other = createArcaTestCredentials({ issuerCn: "Computadores", cuit: "20111111112" })
  const env = arcaTestEnv("production", {}, other)
  assert.ok(configurationErrors(env).some((error) => /CUIT del certificado no coincide con ARCA_CUIT/.test(error)))
  assert.equal(getArcaConfigurationStatus(env).cuitMatches, false)
  assert.ok(configurationErrors({ ...productionEnv, ARCA_CUIT: "123" }).some((error) => /ARCA_CUIT debe contener 11 dígitos/.test(error)))
})

test("certificado vencido o todavía no vigente: rechazado", () => {
  const expired = createArcaTestCredentials({
    issuerCn: "Computadores",
    notBefore: new Date(Date.now() - 400 * DAY_MS),
    notAfter: new Date(Date.now() - DAY_MS),
  })
  assert.ok(configurationErrors(arcaTestEnv("production", {}, expired)).some((error) => /El certificado ARCA venció el/.test(error)))

  const future = createArcaTestCredentials({
    issuerCn: "Computadores",
    notBefore: new Date(Date.now() + DAY_MS),
    notAfter: new Date(Date.now() + 400 * DAY_MS),
  })
  assert.ok(configurationErrors(arcaTestEnv("production", {}, future)).some((error) => /todavía no es válido/.test(error)))

  // El vencimiento se evalúa contra "ahora": el mismo certificado vale hoy y no mañana del vencimiento.
  const status = getArcaConfigurationStatus(productionEnv)
  const afterExpiry = new Date(Date.parse(String(status.certificateExpiresAt)) + DAY_MS)
  assert.ok(configurationErrors(productionEnv, afterExpiry).some((error) => /venció/.test(error)))
})

test("clave privada que no corresponde al certificado (o ilegible): rechazada", () => {
  const env = { ...productionEnv, ARCA_PRIVATE_KEY: createTestKeyPem().privateKey }
  assert.ok(configurationErrors(env).some((error) => /ARCA_PRIVATE_KEY no corresponde al certificado ARCA_CERT/.test(error)))
  assert.equal(getArcaConfigurationStatus(env).privateKeyMatches, false)
  assert.ok(
    configurationErrors({ ...productionEnv, ARCA_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nbasura\n-----END PRIVATE KEY-----" })
      .some((error) => /ARCA_PRIVATE_KEY no se pudo leer/.test(error)),
  )
})

test("faltantes: certificado, clave y punto de venta", () => {
  const errors = configurationErrors({ ARCA_ENV: "production" })
  for (const expected of [/ARCA_CERT no está configurado/, /ARCA_PRIVATE_KEY no está configurada/, /ARCA_PTO_VTA/, /ARCA_CUIT/]) {
    assert.ok(errors.some((error) => expected.test(error)), String(expected))
  }
  const status = getArcaConfigurationStatus({ ...productionEnv, ARCA_PTO_VTA: "0" })
  assert.equal(status.pointOfSaleConfigured, false)
  assert.equal(status.pointOfSale, null)
})

test("PEM en una sola línea con \\n escapados (formato .env) se acepta", () => {
  const escaped = {
    ...productionEnv,
    ARCA_CERT: productionCredentials.certificatePem.trim().replaceAll("\n", "\\n"),
    ARCA_PRIVATE_KEY: productionCredentials.privateKeyPem.trim().replaceAll("\n", "\\n"),
  }
  assert.equal(requireArcaConfiguration(escaped).environment, "production")
})

test("facturación automática: sólo con ARCA_AUTO_INVOICING_ENABLED=true explícito", () => {
  assert.equal(getArcaConfigurationStatus({ ...productionEnv, ARCA_AUTO_INVOICING_ENABLED: "true" }).autoInvoicingEnabled, true)
  for (const value of [undefined, "", "1", "yes", "false"]) {
    assert.equal(getArcaConfigurationStatus({ ...productionEnv, ARCA_AUTO_INVOICING_ENABLED: value }).autoInvoicingEnabled, false)
  }
})

test("el estado y los errores nunca exponen PEM, clave ni CUIT", async () => {
  const leaks = [
    "BEGIN",
    "PRIVATE KEY",
    TEST_CUIT,
    productionCredentials.privateKeyPem.split("\n")[1],
    productionCredentials.certificatePem.split("\n")[1],
  ]
  const invalid = {
    ...productionEnv,
    ARCA_PRIVATE_KEY: createTestKeyPem().privateKey,
    ARCA_ENV: "homologation",
    ARCA_PRIVATE_KEY_PASSPHRASE: "passphrase-secreta",
  }
  const serialized = [
    JSON.stringify(getArcaConfigurationStatus(productionEnv)),
    JSON.stringify(getArcaConfigurationStatus(invalid)),
    JSON.stringify(configurationErrors(invalid)),
    await arcaConfigurationErrorResponse(new ArcaConfigurationError(configurationErrors(invalid))).text(),
  ].join("\n")
  for (const leak of [...leaks, "passphrase-secreta"]) {
    assert.equal(serialized.includes(leak), false, `no expone ${leak.slice(0, 12)}...`)
  }
  const response = arcaConfigurationErrorResponse(new ArcaConfigurationError(["ARCA_ENV no está configurada."]))
  assert.equal(response.status, 503)
})

test("QR fiscal: nunca en homologación ni sin ambiente; en producción sólo con CAE real y datos válidos", () => {
  const voucher = {
    issueDate: "2026-10-01",
    cuit: TEST_CUIT,
    pointOfSale: 1,
    voucherType: 11,
    voucherNumber: 1,
    total: 900,
    cae: "86390927873264",
  }
  assert.equal(buildFiscalArcaQrUrl({ ...voucher, environment: "homologation" }), null)
  assert.equal(buildFiscalArcaQrUrl({ ...voucher, environment: null }), null)
  assert.equal(buildFiscalArcaQrUrl({ ...voucher, environment: "PRODUCTION" }), null)

  const url = buildFiscalArcaQrUrl({ ...voucher, environment: "production" })
  assert.ok(url?.startsWith("https://www.arca.gob.ar/fe/qr/?p="))
  const payload = JSON.parse(Buffer.from(decodeURIComponent(String(url).split("?p=")[1]), "base64").toString("utf8"))
  assert.equal(payload.codAut, 86390927873264)
  assert.equal(payload.cuit, Number(TEST_CUIT))

  for (const invalid of [
    { cae: "" },
    { cae: "123" },
    { cae: "8639092787326A" },
    { cuit: "" },
    { issueDate: "01/10/2026" },
    { pointOfSale: 0 },
    { voucherNumber: 0 },
    { total: 0 },
    { total: Number.NaN },
  ]) {
    assert.equal(buildFiscalArcaQrUrl({ ...voucher, ...invalid, environment: "production" }), null, JSON.stringify(invalid))
  }
})

test("Admin: etiquetas de ambiente/certificado y botón de emitir bloqueado sin configuración válida", () => {
  const homologation = getArcaConfigurationStatus(homologationEnv)
  const production = getArcaConfigurationStatus(productionEnv)
  const invalid = getArcaConfigurationStatus({ ...productionEnv, ARCA_ENV: undefined })

  assert.equal(arcaEnvironmentLabel(production), "Producción")
  assert.equal(arcaEnvironmentLabel(homologation), "Homologación")
  assert.equal(arcaEnvironmentLabel(invalid), "Configuración inválida")
  assert.match(arcaCertificateLabel(production), /^Producción · vence \d{2}\/\d{2}\/\d{4}$/)
  assert.match(arcaCertificateLabel(homologation), /^Homologación · vence /)

  assert.equal(getArcaIssueBlockReason(production), null)
  assert.equal(getArcaIssueBlockReason(homologation), null, "homologación explícita emite (con aviso de prueba)")
  assert.match(String(getArcaIssueBlockReason(invalid)), /Emisión bloqueada por configuración de ARCA inválida\. ARCA_ENV no está configurada/)
  assert.match(String(getArcaIssueBlockReason(null)), /Verificando/, "sin estado todavía: bloqueado")
  assert.match(String(getArcaIssueBlockReason(null, "HTTP 500")), /No se pudo verificar la configuración de ARCA/)
})

function diagnosticsDeps(
  env: Record<string, string | undefined>,
  overrides: Partial<ArcaDiagnosticsDependencies> = {},
) {
  const calls: string[] = []
  const deps: ArcaDiagnosticsDependencies = {
    inspect: () => inspectArcaConfiguration(env),
    dummy: async () => {
      calls.push("dummy")
      return { appServer: "OK", dbServer: "OK", authServer: "OK" }
    },
    authenticate: async (configuration: ArcaConfiguration) => {
      calls.push(`wsaa:${configuration.environment}`)
      return { expirationTime: "2026-10-02T12:00:00-03:00" }
    },
    pointsOfSale: async () => {
      calls.push("ptos")
      return [{ number: 1, emissionType: "CAE", blocked: false, droppedAt: null }]
    },
    lastAuthorized: async (pointOfSale, voucherType) => {
      calls.push(`last:${pointOfSale}:${voucherType}`)
      return voucherType === 11 ? 0 : 0
    },
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  }
  return { deps, calls }
}

test("diagnóstico: configuración inválida no contacta a ARCA", async () => {
  const { deps, calls } = diagnosticsDeps({ ...productionEnv, ARCA_ENV: undefined })
  const report = await runArcaConnectivityDiagnostics(deps)
  assert.equal(report.ok, false)
  assert.equal(report.readyForFirstFiscalInvoice, false)
  assert.deepEqual(report.steps.map((step) => step.id), ["configuration"])
  assert.deepEqual(calls, [])
})

test("diagnóstico en producción: WSAA, FEDummy, punto de venta y último comprobante, sin emitir", async () => {
  const { deps, calls } = diagnosticsDeps(productionEnv)
  const report = await runArcaConnectivityDiagnostics(deps)
  assert.equal(report.ok, true)
  assert.equal(report.readyForFirstFiscalInvoice, true)
  assert.equal(report.nextInvoiceNumber, 1)
  assert.deepEqual(report.steps.map((step) => step.id), ["configuration", "fedummy", "wsaa", "points_of_sale", "last_invoice", "last_credit_note"])
  assert.deepEqual(calls, ["dummy", "wsaa:production", "ptos", "last:1:11", "last:1:13"])
})

test("diagnóstico: punto de venta no habilitado, bloqueado o de baja corta antes de consultar comprobantes", async () => {
  for (const points of [
    [{ number: 2, emissionType: "CAE", blocked: false, droppedAt: null }],
    [{ number: 1, emissionType: "CAE", blocked: true, droppedAt: null }],
    [{ number: 1, emissionType: "CAE", blocked: false, droppedAt: "20260101" }],
    [],
  ]) {
    const { deps, calls } = diagnosticsDeps(productionEnv, { pointsOfSale: async () => points })
    const report = await runArcaConnectivityDiagnostics(deps)
    assert.equal(report.ok, false)
    assert.equal(report.readyForFirstFiscalInvoice, false)
    assert.equal(report.steps.at(-1)?.id, "points_of_sale")
    assert.ok(!calls.some((call) => call.startsWith("last:")))
  }
})

test("diagnóstico: WSAA rechazado se informa sin continuar; homologación nunca queda 'lista para fiscal'", async () => {
  const { deps } = diagnosticsDeps(productionEnv, {
    authenticate: async () => {
      throw new Error("WSAA rechazó la autenticación: ns1:cms.cert.untrusted.")
    },
  })
  const failed = await runArcaConnectivityDiagnostics(deps)
  assert.equal(failed.steps.at(-1)?.id, "wsaa")
  assert.match(String(failed.steps.at(-1)?.detail), /cms\.cert\.untrusted/)

  const homologation = await runArcaConnectivityDiagnostics(diagnosticsDeps(homologationEnv).deps)
  assert.equal(homologation.ok, true)
  assert.equal(homologation.readyForFirstFiscalInvoice, false)
})

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

test("todos los caminos (manual, automático, NC, conciliación y diagnóstico) pasan por el mismo guard", () => {
  // Nivel más bajo: toda llamada autenticada a WSFE y todo TA de WSAA.
  const wsfe = read("lib/arca/wsfe.ts")
  const callWsfe = wsfe.slice(wsfe.indexOf("async function callWsfe("), wsfe.indexOf("async function callWsfePublic("))
  assert.ok(callWsfe.indexOf("requireArcaConfiguration()") < callWsfe.indexOf("getWsaaCredentials(configuration)"))
  assert.ok(callWsfe.indexOf("getWsaaCredentials(configuration)") < callWsfe.indexOf("fetch("))
  assert.match(wsfe, /async function callWsfePublic\([^)]*\) \{\n\s+const environment = getArcaEnvironment\(\)/)
  assert.match(read("lib/arca/wsaa.ts"), /getWsaaCredentials\(configuration: ArcaConfiguration = requireArcaConfiguration\(\)\)/)
  assert.match(read("lib/arca/wsfe-invoice-gateway.ts"), /configuration: ArcaConfiguration = requireArcaConfiguration\(\),/)

  // Rutas: el guard corre antes de tomar pedidos, reservar NC o consultar ARCA.
  const invoice = read("app/api/admin/orders/[id]/invoice/route.ts")
  const cron = read("app/api/cron/arca-invoices/route.ts")
  const creditNote = read("app/api/admin/orders/[id]/credit-note/route.ts")
  const reconcile = read("app/api/admin/credit-notes/[noteId]/reconcile/route.ts")
  for (const [name, source, before] of [
    ["emisión manual", invoice, "processArcaInvoice(auth.admin"],
    ["automática", cron, "processArcaInvoiceQueue(createAdminClient()"],
    ["nota de crédito", creditNote, '.rpc("begin_partial_credit_note"'],
    ["conciliación", reconcile, "reconcileCreditNote(auth.admin"],
  ] as const) {
    const guard = source.indexOf("configuration = requireArcaConfiguration()")
    assert.ok(guard > 0 && guard < source.indexOf(before), `${name}: guard antes de ${before}`)
    assert.match(source, /createWsfeInvoiceGateway\(configuration\)/, name)
  }
  // Manual y automática usan el MISMO punto de venta validado.
  assert.match(invoice, /pointOfSale: configuration\.pointOfSale,/)
  assert.match(cron, /pointOfSale: configuration\.pointOfSale,/)

  // Nadie arma un gateway sin configuración ni lee credenciales por fuera del guard.
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir))) {
      const path = join(dir, entry)
      if (statSync(join(root, path)).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        const source = read(path)
        const normalized = path.replace(/\\/g, "/")
        if (/createWsfeInvoiceGateway\(\)/.test(source)) offenders.push(`${normalized}: gateway sin configuración`)
        if (/process\.env\.(ARCA_CERT|ARCA_PRIVATE_KEY|ARCA_ENV)\b/.test(source) && !/^lib\/arca\/(configuration|environment)\.ts$/.test(normalized)) {
          offenders.push(`${normalized}: credenciales/ambiente fuera del guard`)
        }
      }
    }
  }
  ;["app", "lib"].forEach(walk)
  assert.deepEqual(offenders, [])

  // El diagnóstico no puede pedir un CAE.
  for (const path of ["lib/arca/production-diagnostics.ts", "app/api/admin/arca/diagnostics/route.ts"]) {
    assert.doesNotMatch(read(path), /fecaeSolicitar|FECAESolicitar|requestCae|processArcaInvoice|emitCreditNote/, path)
  }
})
