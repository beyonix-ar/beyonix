/**
 * Ticket de Acceso (TA) de WSAA persistido y compartido por TODOS los procesos
 * del servidor (PM2, reinicios, scripts operativos del mismo usuario).
 *
 * WSAA rechaza pedir un TA nuevo mientras exista uno reciente para el mismo
 * certificado y servicio ("El CEE ya posee un TA valido para el acceso al WSN
 * solicitado"). Con el TA sólo en memoria, un reinicio o un proceso aparte
 * perdía el ticket y quedaba sin poder autenticarse. Por eso:
 *
 *   1. Se reutiliza siempre el TA persistido mientras esté vigente.
 *   2. Un solo proceso a la vez pide TA (candado por archivo exclusivo); los
 *      demás esperan y toman el que ese proceso persiste.
 *   3. Escritura atómica (temporal único + rename) con permisos 0600 en un
 *      directorio 0700: token/sign autorizan a facturar con el CUIT.
 *   4. La clave es ambiente + servicio + certificado: un TA de homologación
 *      jamás se usa en producción ni con otro certificado.
 */

import { createHash, randomUUID } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { ArcaEnvironment } from "./environment.ts"

export interface WsaaTicket {
  token: string
  sign: string
  generationTime: string
  expirationTime: string
}

interface StoredTicket extends WsaaTicket {
  key: string
  environment: ArcaEnvironment
  service: string
}

export interface WsaaTicketScope {
  environment: ArcaEnvironment
  service: string
  certificatePem: string
}

/** Un candado más viejo que esto es de un proceso que murió autenticando. */
export const WSAA_LOCK_STALE_MS = 60_000

export function wsaaTicketCacheKey({ environment, service, certificatePem }: WsaaTicketScope) {
  const certificate = certificatePem.replace(/\s+/g, "")
  return createHash("sha256").update(`${environment}|${service}|${certificate}`).digest("hex")
}

/**
 * Fuera del directorio de la app (no depende de cwd ni se pierde en un
 * redeploy); mismo usuario del SO -> mismo directorio para PM2 y scripts.
 */
export function wsaaTicketCacheDir() {
  return process.env.ARCA_TA_CACHE_DIR?.trim() || join(homedir(), ".beyonix", "arca-wsaa")
}

export function wsaaTicketCachePath(key: string, dir = wsaaTicketCacheDir()) {
  return join(dir, `wsaa-${key.slice(0, 32)}.json`)
}

function lockPath(key: string, dir: string) {
  return join(dir, `wsaa-${key.slice(0, 32)}.lock`)
}

function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") chmodSync(dir, 0o700)
}

export function isUsableTicket(ticket: WsaaTicket | null | undefined, now: number, marginMs: number) {
  if (!ticket?.token || !ticket.sign) return false
  const expiration = Date.parse(ticket.expirationTime)
  return Number.isFinite(expiration) && expiration - marginMs > now
}

/** Vigente con margen y de ESTA clave; cualquier otra cosa -> null. */
export function readCachedTicket(scope: WsaaTicketScope, now: number, marginMs: number, dir = wsaaTicketCacheDir()): WsaaTicket | null {
  const key = wsaaTicketCacheKey(scope)
  try {
    const stored = JSON.parse(readFileSync(wsaaTicketCachePath(key, dir), "utf8")) as Partial<StoredTicket>
    if (stored.key !== key || stored.environment !== scope.environment || stored.service !== scope.service) return null
    const ticket: WsaaTicket = {
      token: String(stored.token ?? ""),
      sign: String(stored.sign ?? ""),
      generationTime: String(stored.generationTime ?? ""),
      expirationTime: String(stored.expirationTime ?? ""),
    }
    return isUsableTicket(ticket, now, marginMs) ? ticket : null
  } catch {
    return null
  }
}

/**
 * Escritura atómica: temporal único (0600, exclusivo) + rename. Si falla, el
 * TA igual se usa en este proceso; sólo se pierde para los demás.
 */
export function writeCachedTicket(scope: WsaaTicketScope, ticket: WsaaTicket, dir = wsaaTicketCacheDir()) {
  const key = wsaaTicketCacheKey(scope)
  const path = wsaaTicketCachePath(key, dir)
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    ensurePrivateDir(dir)
    const stored: StoredTicket = { key, environment: scope.environment, service: scope.service, ...ticket }
    writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600, flag: "wx" })
    renameSync(temporary, path)
    return true
  } catch (error) {
    rmSync(temporary, { force: true })
    console.error("ARCA_WSAA_TICKET_CACHE_WRITE_ERROR", {
      path,
      message: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** Candado entre procesos (creación exclusiva). Devuelve el id o null. */
export function acquireWsaaLock(scope: WsaaTicketScope, now: number, dir = wsaaTicketCacheDir()) {
  const path = lockPath(wsaaTicketCacheKey(scope), dir)
  const id = `${process.pid}:${randomUUID()}`
  ensurePrivateDir(dir)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ id, at: now }), { mode: 0o600, flag: "wx" })
      return id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // Candado de un proceso que murió autenticando: se descarta una vez.
      try {
        if (now - statSync(path).mtimeMs > WSAA_LOCK_STALE_MS) {
          unlinkSync(path)
          continue
        }
      } catch {
        continue
      }
      return null
    }
  }
  return null
}

/** Sólo libera el candado propio. */
export function releaseWsaaLock(scope: WsaaTicketScope, id: string, dir = wsaaTicketCacheDir()) {
  const path = lockPath(wsaaTicketCacheKey(scope), dir)
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as { id?: string }
    if (current.id === id) unlinkSync(path)
  } catch {
    // Ya no existe o es de otro proceso.
  }
}

export function isWsaaAlreadyAuthenticatedFault(message: string | null | undefined) {
  return /ya posee un TA valido|alreadyAuthenticated/i.test(message ?? "")
}

export class WsaaLockTimeoutError extends Error {
  constructor() {
    super("Otro proceso está autenticando con ARCA (WSAA) y no terminó a tiempo. No se pidió ningún CAE; reintentá en unos minutos.")
    this.name = "WsaaLockTimeoutError"
  }
}

export interface ObtainTicketOptions {
  scope: WsaaTicketScope
  /** Login real contra WSAA. Sólo se llama con el candado tomado. */
  request: () => Promise<WsaaTicket>
  marginMs: number
  dir?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  waitTimeoutMs?: number
  pollMs?: number
}

/**
 * Disco -> (candado) disco otra vez -> WSAA -> persistir. Nunca pide un TA
 * si hay uno vigente persistido, y nunca dos procesos piden a la vez.
 */
export async function obtainWsaaTicket({
  scope,
  request,
  marginMs,
  dir = wsaaTicketCacheDir(),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  waitTimeoutMs = 45_000,
  pollMs = 250,
}: ObtainTicketOptions): Promise<WsaaTicket> {
  const deadline = now() + waitTimeoutMs
  for (;;) {
    const cached = readCachedTicket(scope, now(), marginMs, dir)
    if (cached) return cached

    const lock = acquireWsaaLock(scope, now(), dir)
    if (lock) {
      try {
        // Otro proceso pudo persistirlo entre la lectura y el candado.
        const again = readCachedTicket(scope, now(), marginMs, dir)
        if (again) return again
        const ticket = await request()
        writeCachedTicket(scope, ticket, dir)
        return ticket
      } finally {
        releaseWsaaLock(scope, lock, dir)
      }
    }

    if (now() >= deadline) throw new WsaaLockTimeoutError()
    await sleep(pollMs)
  }
}
