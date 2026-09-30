/**
 * Certificados X.509 generados en memoria SÓLO para tests: imitan el emisor
 * ("Computadores" / "Computadores Test", O=AFIP) y el sujeto
 * ("serialNumber=CUIT ...") de los certificados de ARCA. No son certificados
 * reales ni sirven para autenticar contra ARCA.
 */

import { generateKeyPairSync } from "node:crypto"
import forge from "node-forge"

export const TEST_CUIT = "20372812924"

export interface TestCertificateOptions {
  issuerCn?: string
  cuit?: string
  notBefore?: Date
  notAfter?: Date
}

const DAY_MS = 24 * 60 * 60 * 1000

export function createTestKeyPem() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
}

export function createArcaTestCredentials(options: TestCertificateOptions = {}) {
  const { publicKey, privateKey } = createTestKeyPem()
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey)
  certificate.serialNumber = "01"
  certificate.validity.notBefore = options.notBefore ?? new Date(Date.now() - DAY_MS)
  certificate.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * DAY_MS)
  certificate.setSubject([
    { name: "commonName", value: "BEYONIX" },
    { name: "serialNumber", value: `CUIT ${options.cuit ?? TEST_CUIT}` },
  ])
  certificate.setIssuer([
    { name: "countryName", value: "AR" },
    { name: "organizationName", value: "AFIP" },
    { name: "commonName", value: options.issuerCn ?? "Computadores Test" },
  ])
  certificate.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create())

  return { certificatePem: forge.pki.certificateToPem(certificate), privateKeyPem: privateKey }
}

/** Variables ARCA completas y coherentes para el ambiente pedido. */
export function arcaTestEnv(
  environment: "homologation" | "production",
  overrides: Record<string, string | undefined> = {},
  credentials = createArcaTestCredentials({
    issuerCn: environment === "production" ? "Computadores" : "Computadores Test",
  }),
): Record<string, string | undefined> {
  return {
    ARCA_ENV: environment,
    ARCA_CERT: credentials.certificatePem,
    ARCA_PRIVATE_KEY: credentials.privateKeyPem,
    ARCA_CUIT: TEST_CUIT,
    ARCA_PTO_VTA: "1",
    ...overrides,
  }
}
