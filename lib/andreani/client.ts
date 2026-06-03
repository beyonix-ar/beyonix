const ANDREANI_NOT_CONFIGURED_MESSAGE = "Andreani todavía no está configurado"

export interface AndreaniConfig {
  apiUrl: string
  user: string
  password: string
  contrato: string
  cliente: string
  enabled: boolean
}

export interface AndreaniDisabledResponse {
  ok: false
  message: typeof ANDREANI_NOT_CONFIGURED_MESSAGE
}

export function getAndreaniConfig(): AndreaniConfig {
  return {
    apiUrl: process.env.ANDREANI_API_URL || "https://apisqa.andreani.com",
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
    message: ANDREANI_NOT_CONFIGURED_MESSAGE,
  }
}

export function isAndreaniReady(config = getAndreaniConfig()) {
  return Boolean(
    config.enabled &&
      config.apiUrl &&
      config.user &&
      config.password &&
      config.contrato &&
      config.cliente
  )
}

export class AndreaniClient {
  private config: AndreaniConfig

  constructor(config = getAndreaniConfig()) {
    this.config = config
  }

  assertReady() {
    if (!isAndreaniReady(this.config)) {
      throw new Error(ANDREANI_NOT_CONFIGURED_MESSAGE)
    }
  }

  async cotizar() {
    this.assertReady()
    throw new Error("Cotización Andreani pendiente de implementar")
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
