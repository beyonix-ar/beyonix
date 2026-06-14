import forge from "node-forge"

import { escapeXml, getSoapFaultMessage, parseXml } from "@/lib/arca/xml"

const WSAA_HOMOLOGATION_URL =
  "https://wsaahomo.afip.gov.ar/ws/services/LoginCms"
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
  var arcaWsaaRequest: Promise<WsaaCredentials> | undefined
}

function requiredEnv(name: "ARCA_CERT" | "ARCA_PRIVATE_KEY") {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Falta configurar ${name}.`)

  return value.replaceAll("\\n", "\n")
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

export function signTra(tra: string) {
  const certificate = forge.pki.certificateFromPem(requiredEnv("ARCA_CERT"))
  const passphrase = process.env.ARCA_PRIVATE_KEY_PASSPHRASE
  const privateKeyPem = requiredEnv("ARCA_PRIVATE_KEY")
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

async function requestCredentials() {
  const cms = signTra(generateTra())
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${escapeXml(cms)}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`

  const response = await fetch(WSAA_HOMOLOGATION_URL, {
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

  globalThis.arcaWsaaCredentials = credentials
  return credentials
}

export async function getWsaaCredentials() {
  const cached = globalThis.arcaWsaaCredentials
  const expiration = cached ? Date.parse(cached.expirationTime) : 0

  if (cached && expiration - CACHE_MARGIN_MS > Date.now()) {
    return cached
  }

  if (!globalThis.arcaWsaaRequest) {
    globalThis.arcaWsaaRequest = requestCredentials().finally(() => {
      globalThis.arcaWsaaRequest = undefined
    })
  }

  return globalThis.arcaWsaaRequest
}
