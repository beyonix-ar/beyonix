import forge from "node-forge"

import { requireArcaConfiguration, type ArcaConfiguration } from "@/lib/arca/configuration"
import type { ArcaEnvironment } from "@/lib/arca/environment"
import {
  isUsableTicket,
  isWsaaAlreadyAuthenticatedFault,
  obtainWsaaTicket,
  wsaaTicketCacheKey,
  type WsaaTicketScope,
} from "@/lib/arca/wsaa-ticket-cache"
import { escapeXml, getSoapFaultMessage, parseXml } from "@/lib/arca/xml"

const WSAA_URLS: Record<ArcaEnvironment, string> = {
  homologation: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
  production: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
}

const WSAA_SERVICE = "wsfe"
const CACHE_MARGIN_MS = 5 * 60 * 1000

export interface WsaaCredentials {
  token: string
  sign: string
  generationTime: string
  expirationTime: string
}

declare global {
  var arcaWsaaCredentials: WsaaCredentials | undefined
  var arcaWsaaCredentialsKey: string | undefined
  var arcaWsaaRequest: Promise<WsaaCredentials> | undefined
  var arcaWsaaRequestKey: string | undefined
}

function toArcaDate(date: Date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "-00:00")
}

export function generateTra(now = new Date()) {
  const uniqueId = Math.floor(now.getTime() / 1000)
  const generationTime = new Date(now.getTime() - 10 * 60 * 1000)
  const expirationTime = new Date(now.getTime() + 12 * 60 * 60 * 1000)

  return `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${toArcaDate(generationTime)}</generationTime>
    <expirationTime>${toArcaDate(expirationTime)}</expirationTime>
  </header>
  <service>${WSAA_SERVICE}</service>
</loginTicketRequest>`
}

/** Firma con el par certificado/clave YA validado por requireArcaConfiguration. */
export function signTra(tra: string, configuration: ArcaConfiguration) {
  const certificate = forge.pki.certificateFromPem(configuration.certificatePem)
  const passphrase = configuration.privateKeyPassphrase
  const privateKeyPem = configuration.privateKeyPem
  const privateKey = passphrase
    ? forge.pki.decryptRsaPrivateKey(privateKeyPem, passphrase)
    : forge.pki.privateKeyFromPem(privateKeyPem)

  if (!privateKey) {
    throw new Error("No se pudo leer ARCA_PRIVATE_KEY.")
  }

  const signedData = forge.pkcs7.createSignedData()
  signedData.content = forge.util.createBuffer(tra, "utf8")
  signedData.addCertificate(certificate)
  signedData.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      {
        type: forge.pki.oids.contentType,
        value: forge.pki.oids.data,
      },
      {
        type: forge.pki.oids.messageDigest,
      },
      {
        type: forge.pki.oids.signingTime,
        value: new Date().toISOString(),
      },
    ],
  })
  signedData.sign({ detached: false })

  return forge.util.encode64(
    forge.asn1.toDer(signedData.toAsn1()).getBytes(),
  )
}

async function requestCredentials(configuration: ArcaConfiguration) {
  const cms = signTra(generateTra(), configuration)
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${escapeXml(cms)}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`

  const response = await fetch(WSAA_URLS[configuration.environment], {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: '""',
    },
    body: envelope,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const responseXml = await response.text()
  const soap = parseXml<Record<string, any>>(responseXml)
  const fault = getSoapFaultMessage(soap)

  if (!response.ok || fault) {
    if (isWsaaAlreadyAuthenticatedFault(fault)) {
      throw new Error(
        `WSAA rechazó la autenticación: ${fault}. ARCA entregó hace poco un ticket para este certificado a un proceso que no lo persistió en este servidor; hay que esperar el lapso preventivo de WSAA antes de pedir otro. No se pidió ningún CAE.`,
      )
    }
    throw new Error(`WSAA rechazó la autenticación: ${fault ?? response.status}.`)
  }

  const loginTicketXml =
    soap?.Envelope?.Body?.loginCmsResponse?.loginCmsReturn

  if (typeof loginTicketXml !== "string") {
    throw new Error("WSAA devolvió una respuesta sin credenciales.")
  }

  const ticket = parseXml<Record<string, any>>(loginTicketXml)
    ?.loginTicketResponse
  const credentials: WsaaCredentials = {
    token: String(ticket?.credentials?.token ?? ""),
    sign: String(ticket?.credentials?.sign ?? ""),
    generationTime: String(ticket?.header?.generationTime ?? ""),
    expirationTime: String(ticket?.header?.expirationTime ?? ""),
  }

  if (!credentials.token || !credentials.sign || !credentials.expirationTime) {
    throw new Error("WSAA devolvió credenciales incompletas.")
  }

  return credentials
}

/** Ambiente de los endpoints + servicio + certificado configurado. */
function ticketScope(configuration: ArcaConfiguration): WsaaTicketScope {
  return {
    environment: configuration.environment,
    service: WSAA_SERVICE,
    certificatePem: configuration.certificatePem,
  }
}

/**
 * Guard de configuración -> memoria -> TA persistido (compartido entre
 * procesos, sobrevive reinicios) -> WSAA con candado entre procesos. Nunca se
 * pide un TA si hay uno vigente, ni con una configuración inválida.
 */
export async function getWsaaCredentials(configuration: ArcaConfiguration = requireArcaConfiguration()) {
  const scope = ticketScope(configuration)
  const key = wsaaTicketCacheKey(scope)
  const cached = globalThis.arcaWsaaCredentials
  if (cached && globalThis.arcaWsaaCredentialsKey === key && isUsableTicket(cached, Date.now(), CACHE_MARGIN_MS)) {
    return cached
  }

  if (!globalThis.arcaWsaaRequest || globalThis.arcaWsaaRequestKey !== key) {
    globalThis.arcaWsaaRequestKey = key
    globalThis.arcaWsaaRequest = obtainWsaaTicket({
      scope,
      request: () => requestCredentials(configuration),
      marginMs: CACHE_MARGIN_MS,
    })
      .then((credentials) => {
        globalThis.arcaWsaaCredentials = credentials
        globalThis.arcaWsaaCredentialsKey = key
        return credentials
      })
      .finally(() => {
        globalThis.arcaWsaaRequest = undefined
        globalThis.arcaWsaaRequestKey = undefined
      })
  }

  return globalThis.arcaWsaaRequest
}
