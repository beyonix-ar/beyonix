import { asArray, escapeXml, getSoapFaultMessage, parseXml } from "@/lib/arca/xml"
import { getWsaaCredentials } from "@/lib/arca/wsaa"

const WSFE_URLS = {
  homologation: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  production: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
} as const
const WSFE_NAMESPACE = "http://ar.gov.afip.dif.FEV1/"

export type ArcaEnvironment = keyof typeof WSFE_URLS

/**
 * Ambiente ARCA. Por defecto homologación (comportamiento previo): producción
 * sólo con ARCA_ENV=production explícito, para no emitir comprobantes
 * fiscales reales por accidente.
 */
export function getArcaEnvironment(): ArcaEnvironment {
  return process.env.ARCA_ENV?.trim().toLowerCase() === "production"
    ? "production"
    : "homologation"
}

function wsfeUrl() {
  return WSFE_URLS[getArcaEnvironment()]
}

export const FACTURA_C_TYPE = 11
export const NOTA_CREDITO_C_TYPE = 13
export const CONSUMIDOR_FINAL_DOC_TYPE = 99
export const CONSUMIDOR_FINAL_VAT_CONDITION = 5

interface ArcaMessage {
  Code: string
  Msg: string
}

export interface FecaeRequest {
  pointOfSale: number
  voucherType?: number
  voucherNumber: number
  voucherDate: string
  total: number
  documentType?: number
  documentNumber?: number
  receiverVatCondition?: number
  associatedVoucher?: {
    voucherType: number
    pointOfSale: number
    voucherNumber: number
    voucherDate?: string | null
  }
}

export interface FecaeResult {
  cae: string
  caeDueDate: string
  voucherNumber: number
  voucherDate: string
  result: string
  observations: ArcaMessage[]
}

export interface AuthorizedVoucher {
  pointOfSale: number
  voucherType: number
  voucherNumber: number
  voucherDate: string
  /** Presentes cuando ARCA los informa (FECompConsultar.ResultGet). */
  total?: number | null
  cae?: string | null
  caeDueDate?: string | null
  result?: string | null
}

export class ArcaWsError extends Error {
  constructor(
    message: string,
    public readonly details: ArcaMessage[] = [],
    /**
     * true sólo cuando ARCA respondió y RECHAZÓ el comprobante (Resultado R o
     * errores en una respuesta válida): ese número no quedó autorizado. Un
     * timeout, un error HTTP o un SOAP fault NO lo son: el resultado es
     * desconocido y hay que reconciliar antes de pedir otro número.
     */
    public readonly definitiveRejection = false,
  ) {
    super(message)
    this.name = "ArcaWsError"
  }
}

function requiredCuit() {
  const cuit = process.env.ARCA_CUIT?.replace(/\D/g, "")
  if (!cuit || cuit.length !== 11) {
    throw new Error("ARCA_CUIT debe contener 11 dígitos.")
  }

  return cuit
}

function parseMessages(container: any, key: "Err" | "Evt" | "Obs") {
  return asArray<any>(container?.[key]).map((item) => ({
    Code: String(item?.Code ?? ""),
    Msg: String(item?.Msg ?? ""),
  }))
}

function formatAmount(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("El importe del comprobante debe ser mayor que cero.")
  }

  return value.toFixed(2)
}

function buildAssociatedVoucherXml(request: FecaeRequest) {
  if (!request.associatedVoucher) return ""

  const voucherDate = request.associatedVoucher.voucherDate

  return `<ar:CbtesAsoc>
            <ar:CbteAsoc>
              <ar:Tipo>${request.associatedVoucher.voucherType}</ar:Tipo>
              <ar:PtoVta>${request.associatedVoucher.pointOfSale}</ar:PtoVta>
              <ar:Nro>${request.associatedVoucher.voucherNumber}</ar:Nro>
              ${
                voucherDate
                  ? `<ar:CbteFch>${escapeXml(voucherDate)}</ar:CbteFch>`
                  : ""
              }
            </ar:CbteAsoc>
          </ar:CbtesAsoc>`
}

async function callWsfe(operation: string, body: string) {
  const credentials = await getWsaaCredentials()
  const auth = `<ar:Auth>
    <ar:Token>${escapeXml(credentials.token)}</ar:Token>
    <ar:Sign>${escapeXml(credentials.sign)}</ar:Sign>
    <ar:Cuit>${requiredCuit()}</ar:Cuit>
  </ar:Auth>`
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${WSFE_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:${operation}>
      ${auth}
      ${body}
    </ar:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`

  const response = await fetch(wsfeUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${WSFE_NAMESPACE}${operation}"`,
    },
    body: envelope,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const responseXml = await response.text()
  const document = parseXml<Record<string, any>>(responseXml)
  const fault = getSoapFaultMessage(document)

  if (!response.ok || fault) {
    throw new ArcaWsError(
      `WSFEv1 rechazó ${operation}: ${fault ?? `HTTP ${response.status}`}.`,
    )
  }

  return document?.Envelope?.Body?.[`${operation}Response`]?.[
    `${operation}Result`
  ]
}

async function callWsfePublic(operation: string, body = "") {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${WSFE_NAMESPACE}">
  <soapenv:Header/>
  <soapenv:Body>
    <ar:${operation}>
      ${body}
    </ar:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`

  const response = await fetch(wsfeUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${WSFE_NAMESPACE}${operation}"`,
    },
    body: envelope,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  })
  const responseXml = await response.text()
  const document = parseXml<Record<string, any>>(responseXml)
  const fault = getSoapFaultMessage(document)

  if (!response.ok || fault) {
    throw new ArcaWsError(
      `WSFEv1 rechazó ${operation}: ${fault ?? `HTTP ${response.status}`}.`,
    )
  }

  return document?.Envelope?.Body?.[`${operation}Response`]?.[
    `${operation}Result`
  ]
}

export async function getWsfeHealth() {
  const result = await callWsfePublic("FEDummy")

  return {
    appServer: String(result?.AppServer ?? ""),
    dbServer: String(result?.DbServer ?? ""),
    authServer: String(result?.AuthServer ?? ""),
  }
}

export async function feCompUltimoAutorizado(
  pointOfSale: number,
  voucherType = FACTURA_C_TYPE,
) {
  const result = await callWsfe(
    "FECompUltimoAutorizado",
    `<ar:PtoVta>${pointOfSale}</ar:PtoVta>
     <ar:CbteTipo>${voucherType}</ar:CbteTipo>`,
  )
  const errors = parseMessages(result?.Errors, "Err")

  if (errors.length) {
    throw new ArcaWsError("ARCA no pudo consultar el último comprobante.", errors)
  }

  const voucherNumber = Number(result?.CbteNro)
  if (!Number.isInteger(voucherNumber) || voucherNumber < 0) {
    throw new ArcaWsError("ARCA devolvió un número de comprobante inválido.")
  }

  return voucherNumber
}

export async function feCompConsultar(
  pointOfSale: number,
  voucherNumber: number,
  voucherType = FACTURA_C_TYPE,
): Promise<AuthorizedVoucher | null> {
  if (voucherNumber <= 0) return null

  const result = await callWsfe(
    "FECompConsultar",
    `<ar:FeCompConsReq>
      <ar:CbteTipo>${voucherType}</ar:CbteTipo>
      <ar:CbteNro>${voucherNumber}</ar:CbteNro>
      <ar:PtoVta>${pointOfSale}</ar:PtoVta>
    </ar:FeCompConsReq>`,
  )
  const errors = parseMessages(result?.Errors, "Err")

  if (errors.length) {
    throw new ArcaWsError("ARCA no pudo consultar el comprobante autorizado.", errors)
  }

  const voucher = result?.ResultGet
  const voucherDate = String(voucher?.CbteFch ?? "")
  if (!/^\d{8}$/.test(voucherDate)) {
    throw new ArcaWsError("ARCA devolvió una fecha de comprobante inválida.")
  }
  const total = Number(voucher?.ImpTotal)

  return {
    pointOfSale,
    voucherType,
    voucherNumber,
    voucherDate,
    total: Number.isFinite(total) ? total : null,
    cae: voucher?.CodAutorizacion ? String(voucher.CodAutorizacion) : null,
    caeDueDate: voucher?.FchVto ? String(voucher.FchVto) : null,
    result: voucher?.Resultado ? String(voucher.Resultado) : null,
  }
}

export async function fecaeSolicitar(request: FecaeRequest): Promise<FecaeResult> {
  const voucherType = request.voucherType ?? FACTURA_C_TYPE
  const documentType = request.documentType ?? CONSUMIDOR_FINAL_DOC_TYPE
  const documentNumber = request.documentNumber ?? 0
  const receiverVatCondition =
    request.receiverVatCondition ?? CONSUMIDOR_FINAL_VAT_CONDITION
  const total = formatAmount(request.total)
  const associatedVoucherXml = buildAssociatedVoucherXml(request)

  const result = await callWsfe(
    "FECAESolicitar",
    `<ar:FeCAEReq>
      <ar:FeCabReq>
        <ar:CantReg>1</ar:CantReg>
        <ar:PtoVta>${request.pointOfSale}</ar:PtoVta>
        <ar:CbteTipo>${voucherType}</ar:CbteTipo>
      </ar:FeCabReq>
      <ar:FeDetReq>
        <ar:FECAEDetRequest>
          <ar:Concepto>1</ar:Concepto>
          <ar:DocTipo>${documentType}</ar:DocTipo>
          <ar:DocNro>${documentNumber}</ar:DocNro>
          <ar:CbteDesde>${request.voucherNumber}</ar:CbteDesde>
          <ar:CbteHasta>${request.voucherNumber}</ar:CbteHasta>
          <ar:CbteFch>${escapeXml(request.voucherDate)}</ar:CbteFch>
          <ar:ImpTotal>${total}</ar:ImpTotal>
          <ar:ImpTotConc>0.00</ar:ImpTotConc>
          <ar:ImpNeto>${total}</ar:ImpNeto>
          <ar:ImpOpEx>0.00</ar:ImpOpEx>
          <ar:ImpTrib>0.00</ar:ImpTrib>
          <ar:ImpIVA>0.00</ar:ImpIVA>
          <ar:MonId>PES</ar:MonId>
          <ar:MonCotiz>1</ar:MonCotiz>
          <ar:CondicionIVAReceptorId>${receiverVatCondition}</ar:CondicionIVAReceptorId>
          ${associatedVoucherXml}
        </ar:FECAEDetRequest>
      </ar:FeDetReq>
    </ar:FeCAEReq>`,
  )
  const errors = parseMessages(result?.Errors, "Err")
  const detail = asArray<any>(result?.FeDetResp?.FECAEDetResponse)[0]
  const observations = parseMessages(detail?.Observaciones, "Obs")
  const events = parseMessages(result?.Events, "Evt")

  // Respuesta válida con errores: ARCA no autorizó ese número (definitivo).
  // Sin detalle ni errores la respuesta es ilegible: resultado desconocido.
  if (errors.length || !detail) {
    throw new ArcaWsError("ARCA rechazó la solicitud de CAE.", [
      ...errors,
      ...events,
    ], errors.length > 0)
  }

  const cae = String(detail.CAE ?? "")
  const resultCode = String(detail.Resultado ?? result?.FeCabResp?.Resultado ?? "")

  if (resultCode !== "A" || !cae) {
    throw new ArcaWsError("ARCA no autorizó el comprobante.", [
      ...observations,
      ...events,
    ], resultCode === "R")
  }

  return {
    cae,
    caeDueDate: String(detail.CAEFchVto ?? ""),
    voucherNumber: Number(detail.CbteDesde),
    voucherDate: String(detail.CbteFch ?? request.voucherDate),
    result: resultCode,
    observations,
  }
}
