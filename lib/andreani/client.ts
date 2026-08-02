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
  AndreaniPackageQuoteInput,
  AndreaniProductQuoteInput,
  AndreaniQuoteResponse,
  AndreaniSafeError,
  AndreaniTrackingResponse,
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
const ANDREANI_NOT_ENABLED_MESSAGE =
  "La integración operativa con Andreani todavía no está activa."

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

export interface AndreaniClientOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

interface RequestOptions {
  method?: "GET" | "POST"
  authenticated?: boolean
  headers?: HeadersInit
  body?: unknown
  responseType?: "json" | "binary"
  retryAuthentication?: boolean
}

interface CachedToken {
  value: string
  expiresAt: number
}

export interface AndreaniDisabledResponse {
  ok: false
  message: typeof ANDREANI_NOT_ENABLED_MESSAGE
}

const tokenCache = new Map<string, CachedToken>()
const authenticationRequests = new Map<string, Promise<string>>()
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
): AndreaniResolvedConfig {
  const environment = parseEnvironment(env)

  if (environment === "PROD") {
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
      "La configuración de Andreani QA está incompleta.",
    )
  }

  return {
    environment,
    baseUrl: resolveBaseUrl(nonEmpty(env.ANDREANI_QA_API_URL), environment),
    username: secretValue(env.ANDREANI_QA_USERNAME),
    password: secretValue(env.ANDREANI_QA_PASSWORD),
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
      message: "Configuración QA completa.",
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

  constructor(
    code: AndreaniErrorCode,
    message: string,
    options: { status?: number | null; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = "AndreaniError"
    this.code = code
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
  }

  toJSON(): AndreaniSafeError {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
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
  }
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

  constructor(options: AndreaniClientOptions = {}) {
    this.config = resolveAndreaniConfig(options.env)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.developmentLogs = (options.env ?? process.env).NODE_ENV === "development"
  }

  private get cacheKey() {
    return `${this.config.environment}:${this.config.baseUrl}`
  }

  private async performFetch(path: string, options: RequestOptions = {}) {
    const startedAt = this.now()
    const method = options.method ?? "GET"
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers = new Headers(options.headers)
    headers.set("Accept", headers.get("Accept") ?? "application/json")

    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json")
    }

    if (options.authenticated) {
      headers.set("x-authorization-token", await this.authenticate())
    }

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
        if (response.status === 401 || response.status === 403) {
          tokenCache.delete(this.cacheKey)
          throw new AndreaniError(
            "AUTHENTICATION_FAILED",
            "Andreani rechazó la autenticación.",
            { status: response.status },
          )
        }

        if (response.status >= 500) {
          throw new AndreaniError(
            "SERVICE_UNAVAILABLE",
            "Andreani no está disponible temporalmente.",
            { status: response.status, retryable: true },
          )
        }

        throw new AndreaniError(
          "REQUEST_FAILED",
          "Andreani rechazó la solicitud.",
          { status: response.status },
        )
      }

      if (options.responseType === "binary") {
        return { response, payload: await response.arrayBuffer() }
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

  async authenticate() {
    const cached = tokenCache.get(this.cacheKey)
    if (cached && cached.expiresAt > this.now() + TOKEN_REFRESH_MARGIN_MS) {
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
        method: "POST",
        headers: { Authorization: `Basic ${credentials}` },
        body: {
          userName: this.config.username,
          password: this.config.password,
        },
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
    return this.cotizarPaquete({
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

  async cotizarPaquete(
    input: AndreaniPackageQuoteInput,
  ): Promise<AndreaniQuoteResponse> {
    const codigoPostalDestino = assertPostalCode(
      input.codigoPostalDestino,
      "código postal de destino",
    )
    const contrato = assertIdentifier(input.contrato, "contrato")
    const cliente = assertIdentifier(input.cliente, "cliente")
    const codigoSucursalOrigen = input.codigoSucursalOrigen
      ? assertIdentifier(input.codigoSucursalOrigen, "sucursal de origen")
      : undefined
    const valorDeclarado = assertPositiveNumber(
      input.valorDeclarado,
      "valor declarado",
      1_000_000_000,
    )
    const pesoKg = assertPositiveNumber(input.pesoKg, "peso", 1_000)
    const volumenCm3 = assertPositiveNumber(
      input.volumenCm3,
      "volumen",
      100_000_000,
    )
    const query = new URLSearchParams({
      cpDestino: codigoPostalDestino,
      contrato,
      cliente,
      "bultos[0][valorDeclarado]": String(valorDeclarado),
      "bultos[0][volumen]": String(volumenCm3),
      "bultos[0][kilos]": String(pesoKg),
    })
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
    const { payload } = await this.performFetch(`/v1/tarifas?${query}`)
    if (!isRecord(payload)) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani devolvió una cotización inválida.",
      )
    }
    return payload as unknown as AndreaniQuoteResponse
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
    if (!Array.isArray(payload)) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani devolvió un listado de sucursales inválido.",
      )
    }
    return payload as AndreaniBranch[]
  }

  async crearEnvio(
    input: AndreaniCreateShipmentInput,
  ): Promise<AndreaniCreateShipmentResponse> {
    if (!input.items.length) {
      throw new AndreaniError(
        "VALIDATION_ERROR",
        "El envío debe incluir al menos un producto.",
      )
    }
    const bultos = input.items.map((item) => {
      const logistics = resolveAndreaniProductLogistics(
        item.producto,
        item.variante,
      )
      return {
        ...item.bulto,
        kilos: logistics.pesoKg,
        altoCm: logistics.altoCm,
        anchoCm: logistics.anchoCm,
        largoCm: logistics.largoCm,
        volumenCm: logistics.altoCm * logistics.anchoCm * logistics.largoCm,
      }
    })
    const { payload } = await this.performFetch("/v2/ordenes-de-envio", {
      method: "POST",
      authenticated: true,
      body: { ...input.envio, bultos },
    })
    if (!isRecord(payload)) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani devolvió una orden de envío inválida.",
      )
    }
    return payload as unknown as AndreaniCreateShipmentResponse
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
        headers: {
          Accept: request.formato === "zpl" ? "application/zpl" : "application/pdf",
        },
      },
    )
    return {
      contentType:
        response.headers.get("content-type") ??
        (request.formato === "zpl" ? "application/zpl" : "application/pdf"),
      data: payload as ArrayBuffer,
    }
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
    if (!isRecord(payload) || !Array.isArray(payload.eventos)) {
      throw new AndreaniError(
        "INVALID_RESPONSE",
        "Andreani devolvió un seguimiento inválido.",
      )
    }
    return payload as unknown as AndreaniTrackingResponse
  }
}

export function getAndreaniDisabledResponse(): AndreaniDisabledResponse {
  return { ok: false, message: ANDREANI_NOT_ENABLED_MESSAGE }
}

export function isAndreaniReady(env: NodeJS.ProcessEnv = process.env) {
  return getAndreaniConfigurationStatus(env).configured
}

export function getAndreaniHealth(env: NodeJS.ProcessEnv = process.env) {
  const status = getAndreaniConfigurationStatus(env)
  return {
    ok: status.configured,
    enabled: false,
    environment: status.environment,
    configured: status.configured,
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
