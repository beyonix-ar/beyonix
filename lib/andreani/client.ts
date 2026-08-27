import "server-only"

import type {
  AndreaniAuthenticationResponse,
  AndreaniBranch,
  AndreaniBranchFilters,
  AndreaniConnectionTestResult,
  AndreaniCreateShipmentInput,
  AndreaniCreateShipmentResponse,
  AndreaniEnvironment,
  AndreaniErrorCode,
  AndreaniIntegrationStatus,
  AndreaniLabelRequest,
  AndreaniLabelResponse,
  AndreaniLocality,
  AndreaniLocalityFilters,
  AndreaniOrderStatusResponse,
  AndreaniPackageQuoteInput,
  AndreaniProductQuoteInput,
  AndreaniQuoteResponse,
  AndreaniSafeError,
  AndreaniShipmentSearchFilters,
  AndreaniShipmentStatusResponse,
  AndreaniTariffRequest,
  AndreaniTariffResponse,
  AndreaniThirdPartyPointFilters,
  AndreaniTrackingCycle,
  AndreaniTrackingEvent,
  AndreaniTrackingEventName,
  AndreaniTrackingResponse,
} from "./types.ts"
import {
  ANDREANI_TRACKING_CYCLES,
  ANDREANI_TRACKING_EVENTS,
} from "./types.ts"
import {
  IncompleteProductLogisticsError,
  resolveProductLogistics,
} from "../shipping/product-logistics.ts"
import { ProductLogisticsValidationError } from "../shipping/logistics-validation.ts"

const DEFAULT_TIMEOUT_MS = 10_000
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const TEST_DEDUPLICATION_MS = 10_000

const REQUIRED_VARIABLES = {
  QA: [
    "ANDREANI_QA_API_URL",
    "ANDREANI_QA_USERNAME",
    "ANDREANI_QA_PASSWORD",
  ],
  PROD: [
    "ANDREANI_PROD_API_URL",
    "ANDREANI_PROD_USERNAME",
    "ANDREANI_PROD_PASSWORD",
  ],
} as const

interface AndreaniResolvedConfig {
  environment: AndreaniEnvironment
  baseUrl: string
  username: string
  password: string
}

/**
 * Autorización explícita y semánticamente separada para acceder a PROD:
 * "tariffs-only" habilita únicamente GET /login y GET /v1/tarifas (cotización,
 * ya solicitada por Andreani mientras QA es inestable). "shipment-creation"
 * habilita únicamente GET /login y POST /v2/ordenes-de-envio (creación B2C).
 * "shipment-read" habilita autenticación y las lecturas necesarias para
 * consultar una orden, sus trazas y su etiqueta ya creada. Ninguna capacidad
 * se otorga implícitamente.
 */
export type AndreaniProductionAccess =
  | "tariffs-only"
  | "shipment-creation"
  | "shipment-read"

export interface AndreaniClientOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
  productionAccess?: AndreaniProductionAccess
}

interface RequestOptions {
  method?: "GET" | "POST"
  authenticated?: boolean
  headers?: HeadersInit
  body?: unknown
  responseType?: "json" | "binary" | "authentication"
}

interface CachedToken {
  value: string
  expiresAt: number
}

interface AndreaniTariffQueryInput
  extends Omit<AndreaniPackageQuoteInput, "valorDeclarado" | "pesoKg"> {
  valorDeclarado?: number
  pesoKg?: number
}

export interface AndreaniAuthenticationOptions {
  forceRefresh?: boolean
}

const tokenCache = new Map<string, CachedToken>()
const authenticationRequests = new Map<string, Promise<string>>()
const trackingCycles = new Set<string>(ANDREANI_TRACKING_CYCLES)
const trackingEvents = new Set<string>(ANDREANI_TRACKING_EVENTS)
let testRequest: Promise<AndreaniConnectionTestResult> | null = null
let lastTestResult: AndreaniConnectionTestResult | null = null
let lastTestStartedAt = 0

function nonEmpty(value: string | undefined) {
  return typeof value === "string" ? value.trim() : ""
}

function secretValue(value: string | undefined) {
  return typeof value === "string" ? value : ""
}

function parseEnvironment(env: NodeJS.ProcessEnv): AndreaniEnvironment {
  const value = nonEmpty(env.ANDREANI_ENV).toUpperCase()

  if (value !== "QA" && value !== "PROD") {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "El ambiente de Andreani no está configurado correctamente.",
    )
  }

  return value
}

/**
 * Única fuente de verdad para qué ambiente de Andreani sirve los catálogos
 * de referencia territorial (localidades, códigos postales, sucursales).
 * Antes había dos criterios viviendo en paralelo: `checkout-quote.ts`
 * resolvía por `ANDREANI_TARIFF_ENV || ANDREANI_ENV` (PROD en producción)
 * mientras `checkout-destinations.ts` forzaba QA sin importar la
 * configuración -- dos ambientes de Andreani pueden devolver nomenclatura o
 * cobertura de CP distinta para la misma localidad real, así que esa
 * divergencia rompía el circuito completo (el selector de CP consultaba un
 * ambiente y la cotización validaba contra otro). Todo el catálogo de
 * referencia debe resolver siempre por acá.
 */
export function resolveAndreaniReferenceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AndreaniEnvironment {
  const value = nonEmpty(env.ANDREANI_TARIFF_ENV || env.ANDREANI_ENV).toUpperCase()

  if (value !== "QA" && value !== "PROD") {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "El ambiente de referencia territorial de Andreani no está configurado correctamente.",
    )
  }

  return value
}

function resolveBaseUrl(rawValue: string, environment: AndreaniEnvironment) {
  let url: URL

  try {
    url = new URL(rawValue)
  } catch {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "La URL de Andreani no es válida.",
    )
  }

  const expectedHost =
    environment === "QA" ? "apisqa.andreani.com" : "apis.andreani.com"

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== expectedHost ||
    url.username ||
    url.password
  ) {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      "La URL de Andreani no corresponde al ambiente seleccionado.",
    )
  }

  return url.origin
}

export function resolveAndreaniConfig(
  env: NodeJS.ProcessEnv = process.env,
  productionAccess?: AndreaniClientOptions["productionAccess"],
): AndreaniResolvedConfig {
  const environment = parseEnvironment(env)

  if (
    environment === "PROD" &&
    productionAccess !== "tariffs-only" &&
    productionAccess !== "shipment-creation" &&
    productionAccess !== "shipment-read"
  ) {
    throw new AndreaniError(
      "PRODUCTION_BLOCKED",
      "El acceso a Andreani PROD está bloqueado durante esta etapa.",
    )
  }

  const missingVariables = REQUIRED_VARIABLES[environment].filter(
    (name) => !nonEmpty(env[name]),
  )

  if (missingVariables.length > 0) {
    throw new AndreaniError(
      "CONFIGURATION_ERROR",
      `La configuración de Andreani ${environment} está incompleta.`,
    )
  }

  const prefix = `ANDREANI_${environment}`
  return {
    environment,
    baseUrl: resolveBaseUrl(nonEmpty(env[`${prefix}_API_URL`]), environment),
    username: secretValue(env[`${prefix}_USERNAME`]),
    password: secretValue(env[`${prefix}_PASSWORD`]),
  }
}

export function getAndreaniConfigurationStatus(
  env: NodeJS.ProcessEnv = process.env,
): Omit<AndreaniIntegrationStatus, "lastTest"> {
  let environment: AndreaniEnvironment | "INVALID" = "INVALID"

  try {
    environment = parseEnvironment(env)
    resolveAndreaniConfig(env)
    return {
      environment,
      configured: true,
      message: `Configuración ${environment} completa.`,
    }
  } catch (error) {
    const safeError = normalizeAndreaniError(error)
    return {
      environment,
      configured: false,
      message: safeError.message,
    }
  }
}

export class AndreaniError extends Error {
  readonly code: AndreaniErrorCode
  readonly status: number | null
  readonly retryable: boolean
  readonly requestId: string | null

  constructor(
    code: AndreaniErrorCode,
    message: string,
    options: {
      status?: number | null
      retryable?: boolean
      requestId?: string | null
    } = {},
  ) {
    super(message)
    this.name = "AndreaniError"
    this.code = code
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
    this.requestId = options.requestId ?? null
  }

  toJSON(): AndreaniSafeError {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      requestId: this.requestId,
    }
  }
}

export function sanitizeAndreaniMessage(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  let message = value instanceof Error ? value.message : String(value ?? "")

  const secretValues = [
    env.ANDREANI_QA_USERNAME,
    env.ANDREANI_QA_PASSWORD,
    env.ANDREANI_PROD_USERNAME,
    env.ANDREANI_PROD_PASSWORD,
  ].filter((secret): secret is string => Boolean(secret && secret.length >= 3))

  for (const secret of secretValues) {
    message = message.replaceAll(secret, "[DATO PROTEGIDO]")
  }

  message = message
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [DATO PROTEGIDO]")
    .replace(
      /\b(Bearer|x-authorization-token)\s*[:=]?\s*[A-Za-z0-9._~+\-/=]+/gi,
      "$1 [DATO PROTEGIDO]",
    )
    .replace(/\b(token|password|contraseña)\s*[:=]\s*[^\s,;]+/gi, "$1=[DATO PROTEGIDO]")

  return message.slice(0, 240)
}

export function normalizeAndreaniError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AndreaniSafeError {
  if (error instanceof AndreaniError) return error.toJSON()

  return {
    code: "REQUEST_FAILED",
    message: sanitizeAndreaniMessage(
      "No se pudo completar la comunicación con Andreani.",
      env,
    ),
    status: null,
    retryable: false,
    requestId: null,
  }
}

function getAndreaniRequestId(response: Response) {
  const value =
    response.headers.get("x-request-id") ??
    response.headers.get("x-correlation-id") ??
    response.headers.get("trace-id")
  return value && /^[A-Za-z0-9._:-]{1,120}$/.test(value) ? value : null
}

function assertIdentifier(value: string, fieldName: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 80 || !/^[\p{L}\p{N}._/-]+$/u.test(normalized)) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `El campo ${fieldName} no es válido.`,
    )
  }
  return normalized
}

function assertPostalCode(value: string, fieldName: string) {
  const normalized = value.trim().toUpperCase()
  if (!/^(?:\d{4}|[A-Z]\d{4}[A-Z]{3})$/.test(normalized)) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `El ${fieldName} no es válido.`,
    )
  }
  return normalized
}

function assertPositiveNumber(value: number, fieldName: string, max: number) {
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `El campo ${fieldName} no es válido.`,
    )
  }
  return value
}

function resolveAndreaniProductLogistics(
  producto: AndreaniProductQuoteInput["producto"],
  variante: AndreaniProductQuoteInput["variante"],
) {
  try {
    return resolveProductLogistics(producto, variante)
  } catch (error) {
    if (
      error instanceof IncompleteProductLogisticsError ||
      error instanceof ProductLogisticsValidationError
    ) {
      throw new AndreaniError("VALIDATION_ERROR", error.message)
    }
    throw error
  }
}

function getRequiredString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function assertText(value: unknown, fieldName: string, maxLength = 200) {
  const normalized = getRequiredString(value)
  if (!normalized || normalized.length > maxLength) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `El campo ${fieldName} no es válido.`,
    )
  }
  return normalized
}

function optionalText(value: unknown, fieldName: string, maxLength = 200) {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string" && !value.trim()) return undefined
  return assertText(value, fieldName, maxLength)
}

function requiredResponseString(
  record: Record<string, unknown>,
  key: string,
  message: string,
) {
  const value = getRequiredString(record[key])
  if (!value) throw new AndreaniError("INVALID_RESPONSE", message)
  return value
}

function optionalResponseString(record: Record<string, unknown>, key: string) {
  const value = getRequiredString(record[key])
  return value || undefined
}

function optionalAddressComponent(
  record: Record<string, unknown>,
  key: string,
  message: string,
) {
  const rawValue = record[key]
  if (rawValue === undefined || rawValue === null) return undefined
  if (typeof rawValue === "string") return rawValue.trim() || undefined
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return String(rawValue)
  }
  throw new AndreaniError("INVALID_RESPONSE", message)
}

function requiredResponseNumber(
  record: Record<string, unknown>,
  key: string,
  message: string,
) {
  const rawValue = record[key]
  const value =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string" && /^-?\d+(?:\.\d+)?$/.test(rawValue.trim())
        ? Number(rawValue)
        : Number.NaN
  if (!Number.isFinite(value)) {
    throw new AndreaniError("INVALID_RESPONSE", message)
  }
  return value
}

function optionalResponseNumber(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined
}

function requiredRecord(value: unknown, message: string) {
  if (!isRecord(value)) throw new AndreaniError("INVALID_RESPONSE", message)
  return value
}

function requiredStringArray(value: unknown, message: string) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AndreaniError("INVALID_RESPONSE", message)
  }
  return value
}

function readAuthenticationResponse(
  payload: unknown,
  response: Response,
): AndreaniAuthenticationResponse {
  const record = isRecord(payload) ? payload : {}
  const token =
    getRequiredString(record.token) ||
    getRequiredString(record.accessToken) ||
    getRequiredString(record.access_token) ||
    getRequiredString(response.headers.get("x-authorization-token"))

  if (!token) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani respondió sin un token válido.",
    )
  }

  return {
    token,
    refreshToken:
      getRequiredString(record.refreshToken) ||
      getRequiredString(record.refresh_token) ||
      undefined,
  }
}

function parseLocalities(payload: unknown): AndreaniLocality[] {
  if (!Array.isArray(payload)) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió un listado de localidades inválido.",
    )
  }

  return payload.map((item) => {
    const record = requiredRecord(
      item,
      "Andreani devolvió una localidad inválida.",
    )
    const id = requiredResponseNumber(
      record,
      "idDeProvLocalidad",
      "Andreani devolvió una localidad sin identificador.",
    )
    if (!Number.isSafeInteger(id)) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani devolvió una localidad con identificador inválido.",
      )
    }

    return {
      idDeProvLocalidad: id,
      localidad: requiredResponseString(
        record,
        "localidad",
        "Andreani devolvió una localidad sin nombre.",
      ),
      provincia: requiredResponseString(
        record,
        "provincia",
        "Andreani devolvió una localidad sin provincia.",
      ),
      codigosPostales: requiredStringArray(
        record.codigosPostales,
        "Andreani devolvió códigos postales inválidos.",
      ),
    }
  })
}

function parseTariffResponse(payload: unknown): AndreaniTariffResponse {
  const record = requiredRecord(
    payload,
    "Andreani devolvió una cotización inválida.",
  )
  const withoutTax = requiredRecord(
    record.tarifaSinIva,
    "Andreani devolvió una tarifa sin IVA inválida.",
  )
  const withTax = requiredRecord(
    record.tarifaConIva,
    "Andreani devolvió una tarifa con IVA inválida.",
  )
  const parseBreakdown = (
    value: Record<string, unknown>,
    message: string,
  ) => ({
    seguroDistribucion: requiredResponseString(
      value,
      "seguroDistribucion",
      message,
    ),
    distribucion: requiredResponseString(value, "distribucion", message),
    total: requiredResponseString(value, "total", message),
  })

  return {
    pesoAforado: requiredResponseString(
      record,
      "pesoAforado",
      "Andreani devolvió una cotización sin peso aforado.",
    ),
    tarifaSinIva: parseBreakdown(
      withoutTax,
      "Andreani devolvió una tarifa sin IVA incompleta.",
    ),
    tarifaConIva: parseBreakdown(
      withTax,
      "Andreani devolvió una tarifa con IVA incompleta.",
    ),
  }
}

function parseBranches(payload: unknown): AndreaniBranch[] {
  if (!Array.isArray(payload)) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió un listado de sucursales inválido.",
    )
  }

  return payload.map((item) => {
    const record = requiredRecord(
      item,
      "Andreani devolvió una sucursal inválida.",
    )
    const address = requiredRecord(
      record.direccion,
      "Andreani devolvió una sucursal sin dirección.",
    )
    const coordinates = isRecord(record.coordenadas)
      ? {
          latitud: requiredResponseString(
            record.coordenadas,
            "latitud",
            "Andreani devolvió coordenadas inválidas.",
          ),
          longitud: requiredResponseString(
            record.coordenadas,
            "longitud",
            "Andreani devolvió coordenadas inválidas.",
          ),
        }
      : undefined
    const additionalData = isRecord(record.datosAdicionales)
      ? {
          seHaceAtencionAlCliente:
            typeof record.datosAdicionales.seHaceAtencionAlCliente === "boolean"
              ? record.datosAdicionales.seHaceAtencionAlCliente
              : undefined,
          conBuzonInteligente:
            typeof record.datosAdicionales.conBuzonInteligente === "boolean"
              ? record.datosAdicionales.conBuzonInteligente
              : undefined,
          tipo: optionalResponseString(record.datosAdicionales, "tipo"),
          admiteEnvios:
            typeof record.datosAdicionales.admiteEnvios === "boolean"
              ? record.datosAdicionales.admiteEnvios
              : undefined,
          entregaEnvios:
            typeof record.datosAdicionales.entregaEnvios === "boolean"
              ? record.datosAdicionales.entregaEnvios
              : undefined,
        }
      : undefined
    const id = requiredResponseNumber(
      record,
      "id",
      "Andreani devolvió una sucursal sin identificador.",
    )
    if (!Number.isSafeInteger(id)) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani devolvió una sucursal con identificador inválido.",
      )
    }

    return {
      id,
      codigo: requiredResponseString(
        record,
        "codigo",
        "Andreani devolvió una sucursal sin código.",
      ),
      numero: requiredResponseString(
        record,
        "numero",
        "Andreani devolvió una sucursal sin número.",
      ),
      descripcion: requiredResponseString(
        record,
        "descripcion",
        "Andreani devolvió una sucursal sin descripción.",
      ),
      canal: requiredResponseString(
        record,
        "canal",
        "Andreani devolvió una sucursal sin canal.",
      ),
      direccion: {
        calle: optionalAddressComponent(
          address,
          "calle",
          "Andreani devolvió una calle con formato inválido.",
        ),
        numero: optionalAddressComponent(
          address,
          "numero",
          "Andreani devolvió un número de calle con formato inválido.",
        ),
        provincia: requiredResponseString(
          address,
          "provincia",
          "Andreani devolvió una dirección sin provincia.",
        ),
        localidad: requiredResponseString(
          address,
          "localidad",
          "Andreani devolvió una dirección sin localidad.",
        ),
        region: requiredResponseString(
          address,
          "region",
          "Andreani devolvió una dirección sin región.",
        ),
        pais: requiredResponseString(
          address,
          "pais",
          "Andreani devolvió una dirección sin país.",
        ),
        codigoPostal: requiredResponseString(
          address,
          "codigoPostal",
          "Andreani devolvió una dirección sin código postal.",
        ),
      },
      coordenadas: coordinates,
      horarioDeAtencion: optionalResponseString(record, "horarioDeAtencion"),
      datosAdicionales: additionalData,
      telefonos:
        record.telefonos === undefined
          ? undefined
          : requiredStringArray(
              record.telefonos,
              "Andreani devolvió teléfonos inválidos.",
            ),
      codigosPostalesAtendidos:
        record.codigosPostalesAtendidos === undefined
          ? undefined
          : requiredStringArray(
              record.codigosPostalesAtendidos,
              "Andreani devolvió códigos postales atendidos inválidos.",
            ),
    }
  })
}

function parseShipmentBranch(value: unknown) {
  if (!isRecord(value)) return undefined
  const id = optionalResponseString(value, "id")
  const nomenclatura = optionalResponseString(value, "nomenclatura")
  const descripcion = optionalResponseString(value, "descripcion")
  if (!id && !nomenclatura && !descripcion) return {}
  return { id, nomenclatura, descripcion }
}

function parseShipmentPackages(value: unknown) {
  if (!Array.isArray(value)) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió una orden sin bultos válidos.",
    )
  }
  return value.map((item) => {
    const record = requiredRecord(
      item,
      "Andreani devolvió un bulto inválido.",
    )
    const linking = Array.isArray(record.linking)
      ? record.linking.map((link) => {
          const linkRecord = requiredRecord(
            link,
            "Andreani devolvió un enlace de etiqueta inválido.",
          )
          return {
            meta: requiredResponseString(
              linkRecord,
              "meta",
              "Andreani devolvió un enlace sin tipo.",
            ),
            contenido: requiredResponseString(
              linkRecord,
              "contenido",
              "Andreani devolvió un enlace sin contenido.",
            ),
          }
        })
      : undefined
    return {
      numeroDeBulto: requiredResponseString(
        record,
        "numeroDeBulto",
        "Andreani devolvió un bulto sin número.",
      ),
      numeroDeEnvio: requiredResponseString(
        record,
        "numeroDeEnvio",
        "Andreani devolvió un bulto sin número de envío.",
      ),
      totalizador: optionalResponseString(record, "totalizador"),
      linking,
    }
  })
}

function parseCreateShipmentResponse(
  payload: unknown,
): AndreaniCreateShipmentResponse {
  const record = requiredRecord(
    payload,
    "Andreani devolvió una orden de envío inválida.",
  )
  const estado = requiredResponseString(
    record,
    "estado",
    "Andreani devolvió una orden sin estado.",
  )
  if (!["Pendiente", "Solicitado", "Creado", "Creada", "Rechazado"].includes(estado)) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió un estado de pre-envío desconocido.",
    )
  }

  return {
    estado: estado as AndreaniCreateShipmentResponse["estado"],
    tipo: requiredResponseString(
      record,
      "tipo",
      "Andreani devolvió una orden sin tipo.",
    ),
    sucursalDeDistribucion: parseShipmentBranch(record.sucursalDeDistribucion),
    sucursalDeRendicion: parseShipmentBranch(record.sucursalDeRendicion),
    sucursalDeImposicion: parseShipmentBranch(record.sucursalDeImposicion),
    sucursalAbastecedora: parseShipmentBranch(record.sucursalAbastecedora),
    fechaCreacion: optionalResponseString(record, "fechaCreacion"),
    fechaEstimadaDeEntrega: optionalResponseString(
      record,
      "fechaEstimadaDeEntrega",
    ),
    zonaDeReparto: optionalResponseString(record, "zonaDeReparto"),
    numeroDePermisionaria: optionalResponseString(
      record,
      "numeroDePermisionaria",
    ),
    descripcionServicio: optionalResponseString(record, "descripcionServicio"),
    etiquetaRemito: optionalResponseString(record, "etiquetaRemito"),
    etiquetasDocumentoDeCambio: optionalResponseString(
      record,
      "etiquetasDocumentoDeCambio",
    ),
    bultos: parseShipmentPackages(record.bultos),
    agrupadorDeBultos: optionalResponseString(record, "agrupadorDeBultos"),
    etiquetasPorAgrupador: optionalResponseString(
      record,
      "etiquetasPorAgrupador",
    ),
    motivo: optionalResponseString(record, "motivo"),
    gastoEnergetico: optionalResponseString(record, "gastoEnergetico"),
    huellaDeCarbono: optionalResponseString(record, "huellaDeCarbono"),
  }
}

function parseShipmentStatus(payload: unknown): AndreaniShipmentStatusResponse {
  const record = requiredRecord(
    payload,
    "Andreani devolvió un estado de envío inválido.",
  )
  const destination = requiredRecord(
    record.destino,
    "Andreani devolvió un destino inválido.",
  )
  const postal = requiredRecord(
    destination.Postal,
    "Andreani devolvió un destino postal inválido.",
  )
  const packages = Array.isArray(record.bultos)
    ? record.bultos.map((item) => {
        const packageRecord = requiredRecord(
          item,
          "Andreani devolvió un bulto de tracking inválido.",
        )
        return {
          kilos: requiredResponseNumber(
            packageRecord,
            "kilos",
            "Andreani devolvió un peso inválido.",
          ),
          valorDeclaradoConImpuestos: optionalResponseNumber(
            packageRecord,
            "valorDeclaradoConImpuestos",
          ),
          IdDeProducto: optionalResponseString(packageRecord, "IdDeProducto"),
          volumen: requiredResponseNumber(
            packageRecord,
            "volumen",
            "Andreani devolvió un volumen inválido.",
          ),
        }
      })
    : (() => {
        throw new AndreaniError(
          "INVALID_RESPONSE",
          "Andreani devolvió bultos de tracking inválidos.",
        )
      })()
  const distributionBranch = requiredRecord(
    record.sucursalDeDistribucion,
    "Andreani devolvió una sucursal de distribución inválida.",
  )
  const sender = requiredRecord(
    record.remitente,
    "Andreani devolvió un remitente inválido.",
  )
  const recipient = requiredRecord(
    record.destinatario,
    "Andreani devolvió un destinatario inválido.",
  )

  return {
    numeroDeTracking: requiredResponseString(
      record,
      "numeroDeTracking",
      "Andreani devolvió un envío sin tracking.",
    ),
    contrato: requiredResponseString(
      record,
      "contrato",
      "Andreani devolvió un envío sin contrato.",
    ),
    ciclo: requiredResponseString(
      record,
      "ciclo",
      "Andreani devolvió un envío sin ciclo.",
    ),
    estado: requiredResponseString(
      record,
      "estado",
      "Andreani devolvió un envío sin estado.",
    ),
    estadoId: optionalResponseNumber(record, "estadoId"),
    fechaEstado: requiredResponseString(
      record,
      "fechaEstado",
      "Andreani devolvió un envío sin fecha de estado.",
    ),
    servicio: optionalResponseString(record, "servicio"),
    sucursalDeDistribucion: {
      nomenclatura: optionalResponseString(distributionBranch, "nomenclatura"),
      descripcion: optionalResponseString(distributionBranch, "descripcion"),
      id: optionalResponseNumber(distributionBranch, "id"),
    },
    fechaCreacion: requiredResponseString(
      record,
      "fechaCreacion",
      "Andreani devolvió un envío sin fecha de creación.",
    ),
    destino: {
      Postal: {
        localidad: requiredResponseString(
          postal,
          "localidad",
          "Andreani devolvió un destino sin localidad.",
        ),
        region: optionalResponseString(postal, "region"),
        pais: requiredResponseString(
          postal,
          "pais",
          "Andreani devolvió un destino sin país.",
        ),
        direccion: requiredResponseString(
          postal,
          "direccion",
          "Andreani devolvió un destino sin dirección.",
        ),
        codigoPostal: requiredResponseString(
          postal,
          "codigoPostal",
          "Andreani devolvió un destino sin código postal.",
        ),
      },
    },
    remitente: {
      nombreYApellido: optionalResponseString(sender, "nombreYApellido"),
      tipoYNumeroDeDocumento: optionalResponseString(
        sender,
        "tipoYNumeroDeDocumento",
      ),
      eMail: optionalResponseString(sender, "eMail"),
    },
    destinatario: {
      nombreYApellido: optionalResponseString(recipient, "nombreYApellido"),
      tipoYNumeroDeDocumento: optionalResponseString(
        recipient,
        "tipoYNumeroDeDocumento",
      ),
      eMail: optionalResponseString(recipient, "eMail"),
    },
    bultos: packages,
    idDeProducto: optionalResponseString(record, "idDeProducto"),
    referencias: requiredStringArray(
      record.referencias,
      "Andreani devolvió referencias inválidas.",
    ),
  }
}

function parseTrackingResponse(payload: unknown): AndreaniTrackingResponse {
  const record = requiredRecord(
    payload,
    "Andreani devolvió un seguimiento inválido.",
  )
  if (!Array.isArray(record.eventos)) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió eventos de seguimiento inválidos.",
    )
  }

  const eventos: AndreaniTrackingEvent[] = record.eventos.map((item) => {
    const event = requiredRecord(
      item,
      "Andreani devolvió un evento de seguimiento inválido.",
    )
    const ciclo = optionalResponseString(event, "Ciclo")
    const evento = requiredResponseString(
      event,
      "Evento",
      "Andreani devolvió un evento sin nombre.",
    )
    if ((ciclo && !trackingCycles.has(ciclo)) || !trackingEvents.has(evento)) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani devolvió un evento fuera del maestro documentado.",
      )
    }

    return {
      Fecha: requiredResponseString(
        event,
        "Fecha",
        "Andreani devolvió un evento sin fecha.",
      ),
      Ciclo: ciclo as AndreaniTrackingCycle | undefined,
      Evento: evento as AndreaniTrackingEventName,
      Motivo: optionalResponseString(event, "Motivo"),
      Submotivo: optionalResponseString(event, "Submotivo"),
      Estado: optionalResponseString(event, "Estado"),
      EstadoId: optionalResponseNumber(event, "EstadoId"),
      Sucursal: optionalResponseString(event, "Sucursal"),
      SucursalId: optionalResponseString(event, "SucursalId"),
      Comentario: optionalResponseString(event, "Comentario"),
    }
  })

  return { eventos }
}

function validateOrderLocation(value: unknown, fieldName: string) {
  const location = isRecord(value) ? value : null
  if (!location) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `El campo ${fieldName} no es válido.`,
    )
  }
  const hasPostal = isRecord(location.postal)
  const hasOffice = isRecord(location.sucursal)
  if (hasPostal === hasOffice) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `${fieldName} debe indicar un domicilio postal o una sucursal.`,
    )
  }

  if (hasPostal) {
    const postal = location.postal as Record<string, unknown>
    const postalCode = assertText(
      postal.codigoPostal,
      `${fieldName}.codigoPostal`,
      12,
    )
    if (fieldName === "origen" && !/^\d{4}$/.test(postalCode)) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "El código postal de origen debe tener cuatro dígitos.",
      )
    }
    assertText(postal.calle, `${fieldName}.calle`, 40)
    assertText(postal.numero, `${fieldName}.numero`, 40)
    assertText(postal.localidad, `${fieldName}.localidad`, 40)
    optionalText(postal.piso, `${fieldName}.piso`)
    optionalText(postal.departamento, `${fieldName}.departamento`)
    optionalText(postal.region, `${fieldName}.region`)
    optionalText(postal.pais, `${fieldName}.pais`)
    optionalText(postal.casillaDeCorreo, `${fieldName}.casillaDeCorreo`)
    return
  }

  const office = location.sucursal as Record<string, unknown>
  assertText(office.id, `${fieldName}.sucursal.id`)
}

function validateOrderPerson(
  value: unknown,
  fieldName: string,
  phoneTypes: readonly number[],
) {
  const person = isRecord(value) ? value : null
  if (!person) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `El campo ${fieldName} no es válido.`,
    )
  }
  assertText(person.nombreCompleto, `${fieldName}.nombreCompleto`, 40)
  optionalText(person.email, `${fieldName}.email`, 40)
  optionalText(person.documentoTipo, `${fieldName}.documentoTipo`)
  optionalText(person.documentoNumero, `${fieldName}.documentoNumero`, 20)

  if (person.telefonos === undefined) return
  if (!Array.isArray(person.telefonos)) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      `El campo ${fieldName}.telefonos no es válido.`,
    )
  }
  for (const phone of person.telefonos) {
    if (
      !isRecord(phone) ||
      typeof phone.tipo !== "number" ||
      !phoneTypes.includes(phone.tipo)
    ) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        `El tipo de teléfono de ${fieldName} no es válido.`,
      )
    }
    assertText(phone.numero, `${fieldName}.telefonos.numero`, 15)
  }
}

function validateB2COrderInput(input: AndreaniCreateShipmentInput) {
  assertIdentifier(input.envio.contrato, "contrato")
  validateOrderLocation(input.envio.origen, "origen")
  validateOrderLocation(input.envio.destino, "destino")
  validateOrderPerson(input.envio.remitente, "remitente", [0, 1, 2, 3])

  if (
    !Array.isArray(input.envio.destinatario) ||
    input.envio.destinatario.length < 1 ||
    input.envio.destinatario.length > 2
  ) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La orden B2C debe incluir uno o dos destinatarios.",
    )
  }
  input.envio.destinatario.forEach((person, index) =>
    validateOrderPerson(person, `destinatario[${index}]`, [1, 2, 3, 4]),
  )

  if (!Array.isArray(input.items) || input.items.length !== 1) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La orden B2C debe incluir exactamente un bulto.",
    )
  }
}

function buildSearchQuery(filters: AndreaniShipmentSearchFilters) {
  const contrato = optionalText(filters.contrato, "contrato")
  const codigoCliente = optionalText(filters.codigoCliente, "codigoCliente")
  if (!contrato && !codigoCliente) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "La búsqueda requiere contrato o código de cliente.",
    )
  }

  const fechaCreacionDesde = optionalText(
    filters.fechaCreacionDesde,
    "fechaCreacionDesde",
  )
  const fechaCreacionHasta = optionalText(
    filters.fechaCreacionHasta,
    "fechaCreacionHasta",
  )
  const actualizadoDesde = optionalText(
    filters.actualizadoDesde,
    "actualizadoDesde",
  )
  const actualizadoHasta = optionalText(
    filters.actualizadoHasta,
    "actualizadoHasta",
  )
  if (Boolean(fechaCreacionDesde) !== Boolean(fechaCreacionHasta)) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "Las fechas de creación deben informarse juntas.",
    )
  }
  if (Boolean(actualizadoDesde) !== Boolean(actualizadoHasta)) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "Las fechas de actualización deben informarse juntas.",
    )
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/
  for (const value of [
    fechaCreacionDesde,
    fechaCreacionHasta,
    actualizadoDesde,
    actualizadoHasta,
  ]) {
    if (value && !datePattern.test(value)) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "El formato de fecha para buscar envíos no es válido.",
      )
    }
  }

  const limit = optionalText(filters.limit, "limit")
  if (
    limit &&
    (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 1_000)
  ) {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "El límite de búsqueda debe estar entre 1 y 1000.",
    )
  }
  if (filters.format !== undefined && filters.format !== "JSON") {
    throw new AndreaniError(
      "VALIDATION_ERROR",
      "BEYONIX admite únicamente el formato JSON para buscar envíos.",
    )
  }

  const query = new URLSearchParams()
  const values: AndreaniShipmentSearchFilters = {
    numeroDeDocumentoDestinatario: optionalText(
      filters.numeroDeDocumentoDestinatario,
      "numeroDeDocumentoDestinatario",
    ),
    fechaCreacionDesde,
    fechaCreacionHasta,
    contrato,
    limit,
    codigoCliente,
    idDeProducto: optionalText(filters.idDeProducto, "idDeProducto"),
    actualizadoDesde,
    actualizadoHasta,
    format: filters.format,
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, value)
  }
  return query
}

/**
 * Los 4xx de negocio de Andreani (400/404/409/422/429) devuelven un cuerpo
 * ProblemDetails ({ type, title, detail, status, errors }). Se conserva sólo
 * "detail"/"title" -- nunca el cuerpo completo -- para poder diagnosticar sin
 * exponer nada del request ni encabezados.
 */
async function readAndreaniErrorDetail(response: Response): Promise<string | undefined> {
  let text: string
  try {
    text = await response.text()
  } catch {
    return undefined
  }
  if (!text.trim()) return undefined

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(payload)) return undefined

  return getRequiredString(payload.detail) || getRequiredString(payload.title) || undefined
}

function assertJsonResponse(payload: unknown) {
  if (payload === null || payload === undefined) {
    throw new AndreaniError(
      "INVALID_RESPONSE",
      "Andreani devolvió una respuesta inválida.",
    )
  }
  return payload
}

export class AndreaniClient {
  private readonly config: AndreaniResolvedConfig
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly developmentLogs: boolean
  private readonly productionAccess?: AndreaniClientOptions["productionAccess"]

  constructor(options: AndreaniClientOptions = {}) {
    this.productionAccess = options.productionAccess
    this.config = resolveAndreaniConfig(options.env, this.productionAccess)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.developmentLogs = (options.env ?? process.env).NODE_ENV === "development"
  }

  /** Sanitiza texto de Andreani con las credenciales reales de esta instancia. */
  private sanitizeDetail(value: string) {
    return sanitizeAndreaniMessage(value, {
      ...process.env,
      ANDREANI_QA_USERNAME:
        this.config.environment === "QA" ? this.config.username : undefined,
      ANDREANI_QA_PASSWORD:
        this.config.environment === "QA" ? this.config.password : undefined,
      ANDREANI_PROD_USERNAME:
        this.config.environment === "PROD" ? this.config.username : undefined,
      ANDREANI_PROD_PASSWORD:
        this.config.environment === "PROD" ? this.config.password : undefined,
    })
  }

  private get cacheKey() {
    return `${this.config.environment}:${this.config.baseUrl}`
  }

  private async performFetch(path: string, options: RequestOptions = {}) {
    const method = options.method ?? "GET"
    const pathname = path.split("?")[0]
    const publicReferenceRequestAllowed =
      method === "GET" &&
      !options.authenticated &&
      (pathname === "/v1/localidades" || pathname === "/v2/sucursales")
    const productionRequestAllowed =
      publicReferenceRequestAllowed ||
      (this.productionAccess === "tariffs-only" &&
        method === "GET" &&
        (pathname === "/login" || pathname === "/v1/tarifas")) ||
      (this.productionAccess === "shipment-creation" &&
        ((method === "GET" && pathname === "/login") ||
          (method === "POST" && pathname === "/v2/ordenes-de-envio"))) ||
      (this.productionAccess === "shipment-read" &&
        method === "GET" &&
        (pathname === "/login" ||
          /^\/v2\/ordenes-de-envio\/[^/]+(?:\/etiquetas)?$/.test(pathname) ||
          /^\/v3\/envios\/[^/]+\/trazas$/.test(pathname)))

    if (this.config.environment === "PROD" && !productionRequestAllowed) {
      throw new AndreaniError(
        "PRODUCTION_BLOCKED",
        this.productionAccess === "shipment-creation"
          ? "Andreani PROD solo admite autenticación y creación de envíos B2C con autorización explícita."
          : this.productionAccess === "shipment-read"
            ? "Andreani PROD solo admite consultar órdenes, tracking y etiquetas ya creadas."
            : "Andreani PROD solo admite catálogos públicos, autenticación y consulta de tarifas.",
      )
    }

    const headers = new Headers(options.headers)
    if (!headers.has("Accept") && options.responseType !== "binary") {
      headers.set("Accept", "application/json")
    }

    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json")
    }

    if (options.authenticated) {
      headers.set("x-authorization-token", await this.authenticate())
    }

    const startedAt = this.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    if (this.developmentLogs) {
      console.info("[Andreani] request", {
        method,
        path: path.split("?")[0],
        hasQuery: path.includes("?"),
        authenticated: options.authenticated === true,
      })
    }

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        cache: "no-store",
      })

      if (this.developmentLogs) {
        console.info("[Andreani] response", {
          method,
          path: path.split("?")[0],
          status: response.status,
          durationMs: this.now() - startedAt,
        })
      }

      if (!response.ok) {
        const requestId = getAndreaniRequestId(response)
        if (response.status === 401 || response.status === 403) {
          tokenCache.delete(this.cacheKey)
          throw new AndreaniError(
            "AUTHENTICATION_FAILED",
            "Andreani rechazó la autenticación.",
            { status: response.status, requestId },
          )
        }

        if (response.status >= 500) {
          throw new AndreaniError(
            "SERVICE_UNAVAILABLE",
            "Andreani no está disponible temporalmente.",
            { status: response.status, retryable: true, requestId },
          )
        }

        const detail = await readAndreaniErrorDetail(response)
        throw new AndreaniError(
          "REQUEST_FAILED",
          detail ? this.sanitizeDetail(detail) : "Andreani rechazó la solicitud.",
          { status: response.status, requestId },
        )
      }

      if (options.responseType === "binary") {
        return { response, payload: await response.arrayBuffer() }
      }

      if (options.responseType === "authentication") {
        const responseBody = await response.text()
        let payload: unknown = {}

        if (responseBody.trim()) {
          try {
            payload = JSON.parse(responseBody)
          } catch {
            payload = {}
          }
        }

        return { response, payload }
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
      if (!contentType.includes("json")) {
        throw new AndreaniError(
          "INVALID_RESPONSE",
          "Andreani devolvió una respuesta con formato inesperado.",
        )
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new AndreaniError(
          "INVALID_RESPONSE",
          "Andreani devolvió una respuesta JSON inválida.",
        )
      }

      return { response, payload: assertJsonResponse(payload) }
    } catch (error) {
      if (this.developmentLogs) {
        const safeError = normalizeAndreaniError(error)
        console.info("[Andreani] error", {
          method,
          path: path.split("?")[0],
          code: safeError.code,
          status: safeError.status,
          durationMs: this.now() - startedAt,
        })
      }
      if (error instanceof AndreaniError) throw error
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw new AndreaniError(
          "TIMEOUT",
          "Andreani no respondió dentro del tiempo esperado.",
          { retryable: true },
        )
      }
      throw new AndreaniError(
        "SERVICE_UNAVAILABLE",
        "No se pudo establecer comunicación con Andreani.",
        { retryable: true },
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  async authenticate(options: AndreaniAuthenticationOptions = {}) {
    const cached = tokenCache.get(this.cacheKey)
    if (
      !options.forceRefresh &&
      cached &&
      cached.expiresAt > this.now() + TOKEN_REFRESH_MARGIN_MS
    ) {
      return cached.value
    }

    const pending = authenticationRequests.get(this.cacheKey)
    if (pending) return pending

    const request = (async () => {
      if (this.developmentLogs) {
        console.info("[Andreani] authentication", {
          environment: this.config.environment,
          cache: "miss",
        })
      }
      const credentials = Buffer.from(
        `${this.config.username}:${this.config.password}`,
        "utf8",
      ).toString("base64")
      const { response, payload } = await this.performFetch("/login", {
        method: "GET",
        headers: { Authorization: `Basic ${credentials}` },
        responseType: "authentication",
      })
      const authentication = readAuthenticationResponse(payload, response)
      tokenCache.set(this.cacheKey, {
        value: authentication.token,
        expiresAt: this.now() + TOKEN_TTL_MS,
      })
      return authentication.token
    })()

    authenticationRequests.set(this.cacheKey, request)
    try {
      return await request
    } finally {
      authenticationRequests.delete(this.cacheKey)
    }
  }

  async testConnection() {
    await this.authenticate()
  }

  async getLocalidades(
    filters: AndreaniLocalityFilters = {},
  ): Promise<AndreaniLocality[]> {
    const query = new URLSearchParams()
    for (const key of [
      "localidad",
      "provincia",
      "idprovincia",
      "partido",
      "codigosPostales",
      "p",
    ] as const) {
      const value = filters[key]
      if (value !== undefined) query.set(key, assertText(value, key, 500))
    }
    if (filters.p && !/^\d+$/.test(filters.p)) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "El número de página de localidades no es válido.",
      )
    }
    const suffix = query.size ? `?${query}` : ""
    const { payload } = await this.performFetch(`/v1/localidades${suffix}`)
    return parseLocalities(payload)
  }

  async getSucursales(
    filters: AndreaniBranchFilters = {},
  ): Promise<AndreaniBranch[]> {
    return this.consultarSucursales(filters)
  }

  async getPuntosDeTercero(
    filters: AndreaniThirdPartyPointFilters,
  ): Promise<AndreaniBranch[]> {
    const query = new URLSearchParams()
    for (const [key, rawValue] of Object.entries(filters)) {
      if (rawValue !== undefined && rawValue !== "") {
        query.set(
          key,
          typeof rawValue === "boolean"
            ? String(rawValue)
            : assertText(rawValue, key),
        )
      }
    }
    if (!query.has("contrato")) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "El contrato es obligatorio para consultar puntos de tercero.",
      )
    }
    const { payload } = await this.performFetch(
      `/v2/puntos-de-tercero?${query}`,
      { authenticated: true },
    )
    return parseBranches(payload)
  }

  async cotizar(
    input: AndreaniProductQuoteInput,
  ): Promise<AndreaniQuoteResponse> {
    const logistics = resolveAndreaniProductLogistics(
      input.producto,
      input.variante,
    )
    const codigoPostalOrigen = assertPostalCode(
      input.codigoPostalOrigen,
      "código postal de origen",
    )
    if (
      input.modalidadEntrega !== "domicilio" &&
      input.modalidadEntrega !== "sucursal"
    ) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "La modalidad de entrega no es válida.",
      )
    }
    // El contrato oficial no recibe el CP de origen ni la modalidad como query:
    // se validan aquí y se usan para seleccionar contrato/sucursal en el servidor.
    void codigoPostalOrigen
    return this.requestTariff({
      codigoPostalDestino: input.codigoPostalDestino,
      contrato: input.contrato,
      cliente: input.cliente,
      codigoSucursalOrigen: input.codigoSucursalOrigen,
      valorDeclarado: input.valorDeclarado,
      pesoKg: logistics.pesoKg,
      altoCm: logistics.altoCm,
      anchoCm: logistics.anchoCm,
      largoCm: logistics.largoCm,
      volumenCm3: logistics.altoCm * logistics.anchoCm * logistics.largoCm,
    })
  }

  async cotizarEnvio(
    input: AndreaniTariffRequest,
  ): Promise<AndreaniTariffResponse> {
    if (!Array.isArray(input.bultos) || input.bultos.length !== 1) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "El cotizador documentado requiere el bulto en la posición cero.",
      )
    }
    const bulto = input.bultos[0]
    return this.requestTariff({
      codigoPostalDestino: input.cpDestino,
      contrato: input.contrato,
      cliente: input.cliente,
      codigoSucursalOrigen: input.sucursalOrigen,
      valorDeclarado: bulto.valorDeclarado,
      pesoKg: bulto.kilos,
      volumenCm3: bulto.volumen,
      altoCm: bulto.altoCm,
      largoCm: bulto.largoCm,
      anchoCm: bulto.anchoCm,
    })
  }

  async cotizarPaquete(
    input: AndreaniPackageQuoteInput,
  ): Promise<AndreaniQuoteResponse> {
    return this.requestTariff(input)
  }

  private async requestTariff(
    input: AndreaniTariffQueryInput,
  ): Promise<AndreaniTariffResponse> {
    const codigoPostalDestino = assertPostalCode(
      input.codigoPostalDestino,
      "código postal de destino",
    )
    const contrato = assertIdentifier(input.contrato, "contrato")
    const cliente = assertIdentifier(input.cliente, "cliente")
    const codigoSucursalOrigen = input.codigoSucursalOrigen
      ? assertIdentifier(input.codigoSucursalOrigen, "sucursal de origen")
      : undefined
    const valorDeclarado =
      input.valorDeclarado === undefined
        ? undefined
        : assertPositiveNumber(
            input.valorDeclarado,
            "valor declarado",
            1_000_000_000,
          )
    const pesoKg =
      input.pesoKg === undefined
        ? undefined
        : assertPositiveNumber(input.pesoKg, "peso", 1_000)
    const volumenCm3 = assertPositiveNumber(
      input.volumenCm3,
      "volumen",
      100_000_000,
    )
    const query = new URLSearchParams({
      cpDestino: codigoPostalDestino,
      contrato,
      cliente,
      "bultos[0][volumen]": String(volumenCm3),
    })
    if (valorDeclarado !== undefined) {
      query.set("bultos[0][valorDeclarado]", String(valorDeclarado))
    }
    if (pesoKg !== undefined) {
      query.set("bultos[0][kilos]", String(pesoKg))
    }
    if (input.altoCm !== undefined) {
      query.set(
        "bultos[0][altoCm]",
        String(assertPositiveNumber(input.altoCm, "alto", 500)),
      )
    }
    if (input.largoCm !== undefined) {
      query.set(
        "bultos[0][largoCm]",
        String(assertPositiveNumber(input.largoCm, "largo", 500)),
      )
    }
    if (input.anchoCm !== undefined) {
      query.set(
        "bultos[0][anchoCm]",
        String(assertPositiveNumber(input.anchoCm, "ancho", 500)),
      )
    }
    if (codigoSucursalOrigen) {
      query.set("sucursalOrigen", codigoSucursalOrigen)
    }
    const { payload } = await this.performFetch(`/v1/tarifas?${query}`, {
      authenticated: true,
    })
    return parseTariffResponse(payload)
  }

  async consultarSucursales(
    filters: AndreaniBranchFilters = {},
  ): Promise<AndreaniBranch[]> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== "") query.set(key, String(value))
    }
    const suffix = query.size > 0 ? `?${query}` : ""
    const { payload } = await this.performFetch(`/v2/sucursales${suffix}`)
    return parseBranches(payload)
  }

  async crearEnvio(
    input: AndreaniCreateShipmentInput,
  ): Promise<AndreaniCreateShipmentResponse> {
    validateB2COrderInput(input)
    const bultos = input.items.map((item) => {
      const logistics = resolveAndreaniProductLogistics(
        item.producto,
        item.variante,
      )
      if (logistics.pesoKg > 50) {
        throw new AndreaniError(
          "VALIDATION_ERROR",
          "El bulto B2C no puede superar los 50 kg.",
        )
      }
      return {
        ...item.bulto,
        kilos: logistics.pesoKg,
        altoCm: logistics.altoCm,
        anchoCm: logistics.anchoCm,
        largoCm: logistics.largoCm,
        volumenCm:
          item.bulto?.volumenCm === undefined
            ? logistics.altoCm * logistics.anchoCm * logistics.largoCm
            : assertPositiveNumber(
                item.bulto.volumenCm,
                "bulto.volumenCm",
                100_000_000,
              ),
      }
    })
    const { payload } = await this.performFetch("/v2/ordenes-de-envio", {
      method: "POST",
      authenticated: true,
      body: { ...input.envio, bultos },
    })
    return parseCreateShipmentResponse(payload)
  }

  async getEstadoOrden(
    numeroAndreani: string,
  ): Promise<AndreaniOrderStatusResponse> {
    const identifier = encodeURIComponent(
      assertIdentifier(numeroAndreani, "número de Andreani"),
    )
    const { payload } = await this.performFetch(
      `/v2/ordenes-de-envio/${identifier}`,
      { authenticated: true },
    )
    const response = parseCreateShipmentResponse(payload)

    return {
      ...response,
      creada: ["Creado", "Creada"].includes(response.estado),
    }
  }

  async obtenerEtiqueta(
    request: AndreaniLabelRequest,
  ): Promise<AndreaniLabelResponse> {
    const identifier = encodeURIComponent(
      assertIdentifier(request.numeroAndreaniOAgrupador, "número de Andreani"),
    )
    const query = new URLSearchParams()
    for (const key of ["bulto", "tipo", "id", "lote", "desde", "hasta"] as const) {
      const value = request[key]
      if (value) query.set(key, value)
    }
    const suffix = query.size > 0 ? `?${query}` : ""
    const { response, payload } = await this.performFetch(
      `/v2/ordenes-de-envio/${identifier}/etiquetas${suffix}`,
      {
        authenticated: true,
        responseType: "binary",
        headers:
          request.formato === "zpl"
            ? { Accept: "application/zpl" }
            : undefined,
      },
    )
    return {
      contentType:
        response.headers.get("content-type") ??
        (request.formato === "zpl" ? "application/zpl" : "application/pdf"),
      data: payload as ArrayBuffer,
    }
  }

  async getEtiquetas(
    numeroAndreaniOAgrupador: string,
    formato: AndreaniLabelRequest["formato"] = "pdf",
  ): Promise<AndreaniLabelResponse> {
    return this.obtenerEtiqueta({ numeroAndreaniOAgrupador, formato })
  }

  async getEstadoEnvio(
    numeroAndreani: string,
  ): Promise<AndreaniShipmentStatusResponse> {
    const identifier = encodeURIComponent(
      assertIdentifier(numeroAndreani, "número de Andreani"),
    )
    const { payload } = await this.performFetch(`/v2/envios/${identifier}`, {
      authenticated: true,
    })
    return parseShipmentStatus(payload)
  }

  async buscarEnvio(
    filters: AndreaniShipmentSearchFilters,
  ): Promise<AndreaniShipmentStatusResponse> {
    const query = buildSearchQuery(filters)
    const { payload } = await this.performFetch(`/v2/envios?${query}`, {
      authenticated: true,
    })
    return parseShipmentStatus(payload)
  }

  async consultarSeguimiento(
    numeroAndreani: string,
  ): Promise<AndreaniTrackingResponse> {
    const identifier = encodeURIComponent(
      assertIdentifier(numeroAndreani, "número de Andreani"),
    )
    const { payload } = await this.performFetch(
      `/v3/envios/${identifier}/trazas`,
      { authenticated: true },
    )
    return parseTrackingResponse(payload)
  }

  async getTrackingPullV3(
    numeroAndreani: string,
  ): Promise<AndreaniTrackingResponse> {
    return this.consultarSeguimiento(numeroAndreani)
  }
}

export async function getLocalidades(
  filters: AndreaniLocalityFilters = {},
  options: AndreaniClientOptions = {},
): Promise<AndreaniLocality[]> {
  return new AndreaniClient(options).getLocalidades(filters)
}

export async function getSucursales(
  filters: AndreaniBranchFilters = {},
  options: AndreaniClientOptions = {},
): Promise<AndreaniBranch[]> {
  return new AndreaniClient(options).getSucursales(filters)
}

export async function getPuntosDeTercero(
  filters: AndreaniThirdPartyPointFilters,
  options: AndreaniClientOptions = {},
): Promise<AndreaniBranch[]> {
  return new AndreaniClient(options).getPuntosDeTercero(filters)
}

export async function cotizarEnvio(
  input: AndreaniTariffRequest,
  options: AndreaniClientOptions = {},
): Promise<AndreaniTariffResponse> {
  return new AndreaniClient(options).cotizarEnvio(input)
}

export async function crearOrdenEnvio(
  input: AndreaniCreateShipmentInput,
  options: AndreaniClientOptions = {},
): Promise<AndreaniCreateShipmentResponse> {
  return new AndreaniClient(options).crearEnvio(input)
}

export async function getEstadoOrden(
  numeroAndreani: string,
  options: AndreaniClientOptions = {},
): Promise<AndreaniOrderStatusResponse> {
  return new AndreaniClient(options).getEstadoOrden(numeroAndreani)
}

export async function getEtiquetas(
  numeroAndreaniOAgrupador: string,
  formato: AndreaniLabelRequest["formato"] = "pdf",
  options: AndreaniClientOptions = {},
): Promise<AndreaniLabelResponse> {
  return new AndreaniClient(options).getEtiquetas(
    numeroAndreaniOAgrupador,
    formato,
  )
}

export async function getEstadoEnvio(
  numeroAndreani: string,
  options: AndreaniClientOptions = {},
): Promise<AndreaniShipmentStatusResponse> {
  return new AndreaniClient(options).getEstadoEnvio(numeroAndreani)
}

export async function getTrackingPullV3(
  numeroAndreani: string,
  options: AndreaniClientOptions = {},
): Promise<AndreaniTrackingResponse> {
  return new AndreaniClient(options).getTrackingPullV3(numeroAndreani)
}

export async function buscarEnvio(
  filters: AndreaniShipmentSearchFilters,
  options: AndreaniClientOptions = {},
): Promise<AndreaniShipmentStatusResponse> {
  return new AndreaniClient(options).buscarEnvio(filters)
}

export async function getAndreaniToken(
  options: AndreaniClientOptions = {},
  authenticationOptions: AndreaniAuthenticationOptions = {},
): Promise<string> {
  return new AndreaniClient(options).authenticate(authenticationOptions)
}

export function isAndreaniReady(env: NodeJS.ProcessEnv = process.env) {
  return getAndreaniConfigurationStatus(env).configured
}

export function getAndreaniHealth(env: NodeJS.ProcessEnv = process.env) {
  const status = getAndreaniConfigurationStatus(env)
  return {
    ok: status.configured && lastTestResult?.status === "success",
    environment: status.environment,
    configured: status.configured,
    authenticated:
      lastTestResult === null ? null : lastTestResult.status === "success",
    message: status.message,
  }
}

export function getAndreaniIntegrationStatus(
  env: NodeJS.ProcessEnv = process.env,
): AndreaniIntegrationStatus {
  return { ...getAndreaniConfigurationStatus(env), lastTest: lastTestResult }
}

export async function testAndreaniQaConnection(
  options: AndreaniClientOptions = {},
): Promise<AndreaniConnectionTestResult> {
  const now = options.now?.() ?? Date.now()

  if (
    lastTestResult &&
    now - lastTestStartedAt < TEST_DEDUPLICATION_MS
  ) {
    return lastTestResult
  }

  if (testRequest) return testRequest

  lastTestStartedAt = now
  testRequest = (async () => {
    try {
      const client = new AndreaniClient(options)
      await client.testConnection()
      return {
        status: "success" as const,
        environment: "QA" as const,
        testedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        message: "Autenticación y conexión con Andreani QA correctas.",
      }
    } catch (error) {
      const safeError = normalizeAndreaniError(error, options.env)
      return {
        status: "error" as const,
        environment: "QA" as const,
        testedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
        message: safeError.message,
      }
    }
  })()

  try {
    lastTestResult = await testRequest
    return lastTestResult
  } finally {
    testRequest = null
  }
}

export function resetAndreaniRuntimeStateForTests() {
  tokenCache.clear()
  authenticationRequests.clear()
  testRequest = null
  lastTestResult = null
  lastTestStartedAt = 0
}
