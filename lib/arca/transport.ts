import { Agent, fetch as undiciFetch } from "undici"

// Sólo WSFE PROD confirmó un servidor con DH legado. El agente no es global.
export const WSFE_PRODUCTION_URL = "https://servicios1.afip.gov.ar/wsfev1/service.asmx"

const wsfeProductionAgent = new Agent({
  connect: {
    ciphers: "DEFAULT:@SECLEVEL=1",
    rejectUnauthorized: true,
  },
})

export function getArcaTlsDispatcher(url: string) {
  return url === WSFE_PRODUCTION_URL ? wsfeProductionAgent : undefined
}

interface ArcaFetchInit {
  method: "POST"
  headers: Record<string, string>
  body: string
  cache: "no-store"
  signal: AbortSignal
}

export function arcaFetch(url: string, init: ArcaFetchInit) {
  const dispatcher = getArcaTlsDispatcher(url)
  if (dispatcher) {
    // No seguir redirecciones con este agente hacia otro origen.
    return undiciFetch(url, { ...init, dispatcher, redirect: "error" })
  }

  return fetch(url, init)
}
