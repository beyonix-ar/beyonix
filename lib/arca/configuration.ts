/**
 * Guard ÚNICO de configuración ARCA. Todo camino que contacta a WSAA/WSFE
 * (emisión manual, worker automático, notas de crédito, conciliaciones y
 * diagnóstico) pasa por requireArcaConfiguration() ANTES de cualquier request:
 *
 *   - ARCA_ENV explícito (homologation | production), sin ambiente por defecto;
 *   - certificado de la CA de ARCA que corresponde al ambiente
 *     ("Computadores" en producción, "Computadores Test" en homologación);
 *   - certificado vigente, con el mismo CUIT que ARCA_CUIT;
 *   - clave privada legible y par del certificado;
 *   - ARCA_PTO_VTA entero > 0.
 *
 * Nada de lo que devuelve (estado o errores) incluye PEM, claves, passphrase
 * ni el CUIT: es seguro mostrarlo en Admin y registrarlo en logs.
 */

import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto"

import {
  ArcaConfigurationError,
  readArcaEnvironment,
  type ArcaEnvironment,
} from "./environment.ts"
import { getArcaPointOfSale } from "./invoice-automation.ts"

export type ArcaCertificateType = "production" | "homologation"

/** Estado seguro para Admin: sin secretos. */
export interface ArcaConfigurationStatus {
  configured: boolean
  environment: ArcaEnvironment | null
  certificateType: ArcaCertificateType | null
  certificateExpiresAt: string | null
  cuitMatches: boolean
  privateKeyMatches: boolean
  pointOfSale: number | null
  pointOfSaleConfigured: boolean
  autoInvoicingEnabled: boolean
  errors: string[]
}

/** Configuración validada que usan WSAA/WSFE. Nunca sale del servidor. */
export interface ArcaConfiguration {
  environment: ArcaEnvironment
  cuit: string
  pointOfSale: number
  certificatePem: string
  privateKeyPem: string
  privateKeyPassphrase: string | undefined
  certificateExpiresAt: string
}

/** process.env o un objeto equivalente (tests, diagnóstico). */
export type ArcaEnvSource = { readonly [key: string]: string | undefined }

const CERTIFICATE_AUTHORITIES: Record<ArcaCertificateType, string> = {
  production: "Computadores",
  homologation: "Computadores Test",
}

function pemFromEnv(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed.replaceAll("\\n", "\n") : null
}

/** Node representa el DN como líneas "CLAVE=valor". */
function distinguishedNameField(name: string, field: string) {
  const prefix = `${field}=`
  return name
    .split(/\n|,\s*/)
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() ?? null
}

/** Tipo de certificado según la CA emisora de ARCA; cualquier otra -> null. */
export function arcaCertificateTypeFromIssuer(issuer: string): ArcaCertificateType | null {
  const commonName = distinguishedNameField(issuer, "CN")
  if (commonName === CERTIFICATE_AUTHORITIES.homologation) return "homologation"
  if (commonName === CERTIFICATE_AUTHORITIES.production) return "production"
  return null
}

function formatArgentinaDate(date: Date) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

interface InspectedConfiguration {
  status: ArcaConfigurationStatus
  configuration: ArcaConfiguration | null
}

export function inspectArcaConfiguration(
  env: ArcaEnvSource = process.env,
  now: Date = new Date(),
): InspectedConfiguration {
  const errors: string[] = []

  const environmentResult = readArcaEnvironment(env.ARCA_ENV)
  const environment = environmentResult.environment ?? null
  if (environmentResult.error !== undefined) errors.push(environmentResult.error)

  const cuit = env.ARCA_CUIT?.replace(/\D/g, "") ?? ""
  const cuitValid = cuit.length === 11
  if (!cuitValid) errors.push("ARCA_CUIT debe contener 11 dígitos.")

  let pointOfSale: number | null = null
  try {
    pointOfSale = getArcaPointOfSale(env.ARCA_PTO_VTA)
  } catch {
    errors.push("ARCA_PTO_VTA no está configurado o no es un entero mayor que cero.")
  }

  let certificate: X509Certificate | null = null
  let certificateType: ArcaCertificateType | null = null
  let certificateExpiresAt: string | null = null
  let cuitMatches = false
  const certificatePem = pemFromEnv(env.ARCA_CERT)
  if (!certificatePem) {
    errors.push("ARCA_CERT no está configurado.")
  } else {
    try {
      certificate = new X509Certificate(certificatePem)
    } catch {
      errors.push("ARCA_CERT no es un certificado X.509 válido en formato PEM.")
    }
  }

  if (certificate) {
    certificateType = arcaCertificateTypeFromIssuer(certificate.issuer)
    if (!certificateType) {
      errors.push("El certificado no fue emitido por una CA de ARCA (Computadores / Computadores Test).")
    }

    const validTo = new Date(certificate.validTo)
    const validFrom = new Date(certificate.validFrom)
    certificateExpiresAt = Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null
    if (!certificateExpiresAt) {
      errors.push("No se pudo leer el vencimiento del certificado.")
    } else if (validTo.getTime() <= now.getTime()) {
      errors.push(`El certificado ARCA venció el ${formatArgentinaDate(validTo)}.`)
    }
    if (Number.isFinite(validFrom.getTime()) && validFrom.getTime() > now.getTime()) {
      errors.push("El certificado ARCA todavía no es válido.")
    }

    const certificateCuit = /CUIT\s*(\d{11})/i.exec(certificate.subject)?.[1] ?? null
    if (!certificateCuit) {
      errors.push("El certificado no informa un CUIT.")
    } else if (cuitValid) {
      cuitMatches = certificateCuit === cuit
      if (!cuitMatches) errors.push("El CUIT del certificado no coincide con ARCA_CUIT.")
    }

    if (environment === "production" && certificateType === "homologation") {
      errors.push("ARCA_ENV=production no admite un certificado de homologación (Computadores Test).")
    }
    if (environment === "homologation" && certificateType === "production") {
      errors.push("ARCA_ENV=homologation no admite el certificado de producción: un comprobante de prueba nunca se firma con el certificado fiscal.")
    }
  }

  let privateKeyMatches = false
  const privateKeyPem = pemFromEnv(env.ARCA_PRIVATE_KEY)
  const privateKeyPassphrase = env.ARCA_PRIVATE_KEY_PASSPHRASE || undefined
  if (!privateKeyPem) {
    errors.push("ARCA_PRIVATE_KEY no está configurada.")
  } else {
    let privateKey: KeyObject | null = null
    try {
      privateKey = createPrivateKey({ key: privateKeyPem, format: "pem", passphrase: privateKeyPassphrase })
    } catch {
      errors.push("ARCA_PRIVATE_KEY no se pudo leer (formato o passphrase incorrectos).")
    }
    if (privateKey && certificate) {
      privateKeyMatches = certificate.checkPrivateKey(privateKey)
      if (!privateKeyMatches) errors.push("ARCA_PRIVATE_KEY no corresponde al certificado ARCA_CERT.")
    }
  }

  const status: ArcaConfigurationStatus = {
    configured: errors.length === 0,
    environment,
    certificateType,
    certificateExpiresAt,
    cuitMatches,
    privateKeyMatches,
    pointOfSale,
    pointOfSaleConfigured: pointOfSale !== null,
    autoInvoicingEnabled: env.ARCA_AUTO_INVOICING_ENABLED?.trim().toLowerCase() === "true",
    errors,
  }

  const configuration =
    status.configured && environment && certificatePem && privateKeyPem && pointOfSale && certificateExpiresAt
      ? {
          environment,
          cuit,
          pointOfSale,
          certificatePem,
          privateKeyPem,
          privateKeyPassphrase,
          certificateExpiresAt,
        }
      : null

  return { status, configuration }
}

export function getArcaConfigurationStatus(env: ArcaEnvSource = process.env, now: Date = new Date()) {
  return inspectArcaConfiguration(env, now).status
}

/**
 * Guard previo a cualquier autenticación o emisión. Lanza
 * ArcaConfigurationError (sin secretos) si algo no cierra.
 */
export function requireArcaConfiguration(env: ArcaEnvSource = process.env, now: Date = new Date()): ArcaConfiguration {
  const { status, configuration } = inspectArcaConfiguration(env, now)
  if (!configuration) throw new ArcaConfigurationError(status.errors)
  return configuration
}

/** Respuesta HTTP uniforme para Admin/cron: 503, errores sin secretos. */
export function arcaConfigurationErrorResponse(error: ArcaConfigurationError) {
  return Response.json(
    { error: error.message, arca_configuration_errors: error.errors },
    { status: 503 },
  )
}
