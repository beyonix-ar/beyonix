/**
 * Redirige, SÓLO en el proceso del arnés, los dos módulos que el arnés
 * reemplaza. Se registra antes de importar las rutas; ningún otro módulo
 * cambia y el código de producción no se toca.
 */

import { readFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const SHIMMED_SPECIFIERS: Record<string, string> = {
  "@/app/api/admin/clientes/_auth": "scripts/arca-homologation/shims/admin-auth.ts",
  "@/lib/arca/wsfe-invoice-gateway": "scripts/arca-homologation/shims/wsfe-invoice-gateway.ts",
}

/**
 * La ruta debe importar auth y gateway EXACTAMENTE por estos especificadores;
 * si alguien los cambia, el arnés se niega a correrla (nunca usa el gateway
 * real sin las protecciones del shim).
 */
export function assertRouteUsesShims(routeFile: string, root = process.cwd()) {
  const source = readFileSync(join(root, routeFile), "utf8")
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
  for (const specifier of Object.keys(SHIMMED_SPECIFIERS)) {
    if (!imports.includes(specifier)) {
      throw new Error(`Arnés ARCA: ${routeFile} no importa "${specifier}"; no se ejecuta.`)
    }
  }
  const otherGatewayImport = imports.some(
    (specifier) => /wsfe-invoice-gateway(\.ts)?$/.test(specifier) && !(specifier in SHIMMED_SPECIFIERS),
  )
  if (otherGatewayImport || /\bfecaeSolicitar\s*\(/.test(source)) {
    throw new Error(`Arnés ARCA: ${routeFile} puede pedir CAE por fuera del gateway interceptado; no se ejecuta.`)
  }
}

let registered = false

export function registerRouteShims(root = process.cwd()) {
  if (registered) return
  const targets = new Map(
    Object.entries(SHIMMED_SPECIFIERS).map(([specifier, file]) => [specifier, pathToFileURL(join(root, file)).href]),
  )
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = targets.get(specifier)
      return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
    },
  })
  registered = true
}
