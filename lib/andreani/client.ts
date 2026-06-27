const ANDREANI_NOT_ENABLED_MESSAGE =
  "Andreani todavía no está habilitado para cotización real"

export interface AndreaniConfig {
  apiBaseUrl: string
  credentialId: string
  user: string
  password: string
  contrato: string
  cliente: string
  enabled: boolean
}

export interface AndreaniDisabledResponse {
  ok: false
  message: typeof ANDREANI_NOT_ENABLED_MESSAGE
}

export interface AndreaniCotizarPayload {
  cpDestino: string
  provincia: string
  localidad: string
  pesoGramos: number
  altoCm: number
  anchoCm: number
  largoCm: number
  valorDeclarado: number
}

export interface AndreaniShippingOption {
  type: "sucursal" | "domicilio"
  label: string
  price: number
}

export interface AndreaniCotizarResponse {
  options: AndreaniShippingOption[]
}

export function getAndreaniConfig(): AndreaniConfig {
  return {
    apiBaseUrl:
      process.env.ANDREANI_API_BASE_URL ||
      process.env.ANDREANI_API_URL ||
      "https://apisqa.andreani.com",
    credentialId: process.env.ANDREANI_CREDENTIAL_ID || "",
    user: process.env.ANDREANI_USER || "",
    password: process.env.ANDREANI_PASSWORD || "",
    contrato: process.env.ANDREANI_CONTRATO || "",
    cliente: process.env.ANDREANI_CLIENTE || "",
    enabled: process.env.ANDREANI_ENABLED === "true",
  }
}

export function getAndreaniDisabledResponse(): AndreaniDisabledResponse {
  return {
    ok: false,
    message: ANDREANI_NOT_ENABLED_MESSAGE,
  }
}

export function isAndreaniReady(config = getAndreaniConfig()) {
  return Boolean(
    config.enabled &&
      config.apiBaseUrl &&
      (config.credentialId ||
        (config.user && config.password && config.contrato && config.cliente))
  )
}

function getRequiredString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function getRequiredPositiveNumber(value: unknown) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null
}

export function parseAndreaniCotizarPayload(
  payload: unknown
): AndreaniCotizarPayload {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {}

  const cpDestino = getRequiredString(record.cpDestino)
  const provincia = getRequiredString(record.provincia)
  const localidad = getRequiredString(record.localidad)
  const pesoGramos = getRequiredPositiveNumber(record.pesoGramos)
  const altoCm = getRequiredPositiveNumber(record.altoCm)
  const anchoCm = getRequiredPositiveNumber(record.anchoCm)
  const largoCm = getRequiredPositiveNumber(record.largoCm)
  const valorDeclarado = getRequiredPositiveNumber(record.valorDeclarado)

  const missingFields = [
    ["cpDestino", cpDestino],
    ["provincia", provincia],
    ["localidad", localidad],
    ["pesoGramos", pesoGramos],
    ["altoCm", altoCm],
    ["anchoCm", anchoCm],
    ["largoCm", largoCm],
    ["valorDeclarado", valorDeclarado],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field)

  if (missingFields.length) {
    throw new Error(`Faltan datos para cotizar: ${missingFields.join(", ")}`)
  }

  return {
    cpDestino,
    provincia,
    localidad,
    pesoGramos: pesoGramos as number,
    altoCm: altoCm as number,
    anchoCm: anchoCm as number,
    largoCm: largoCm as number,
    valorDeclarado: valorDeclarado as number,
  }
}

export function getAndreaniHealth() {
  const config = getAndreaniConfig()

  return {
    ok: true,
    enabled: config.enabled,
    credentialConfigured: Boolean(config.credentialId),
    apiBaseUrlConfigured: Boolean(config.apiBaseUrl),
    ready: isAndreaniReady(config),
    message: config.credentialId
      ? "Credencial Andreani configurada en backend"
      : "Falta configurar ANDREANI_CREDENTIAL_ID",
    todo:
      "Validar con documentación oficial de Andreani si la credencial de WooCommerce sirve para una integración custom y confirmar URL/base path antes de cotizar envíos reales.",
  }
}

export class AndreaniClient {
  private config: AndreaniConfig

  constructor(config = getAndreaniConfig()) {
    this.config = config
  }

  assertReady() {
    if (!isAndreaniReady(this.config)) {
      throw new Error(ANDREANI_NOT_ENABLED_MESSAGE)
    }
  }

  async cotizar(
    payload: AndreaniCotizarPayload
  ): Promise<AndreaniCotizarResponse> {
    this.assertReady()
    void payload
    throw new Error(
      "Cotización Andreani pendiente de implementar hasta confirmar URL, headers y payload oficiales"
    )
  }

  async crearEnvio() {
    this.assertReady()
    throw new Error("Creación de envío Andreani pendiente de implementar")
  }

  async tracking() {
    this.assertReady()
    throw new Error("Tracking Andreani pendiente de implementar")
  }
}
