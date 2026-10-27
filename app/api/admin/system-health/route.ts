import { requireInternalUser } from "@/lib/auth/admin-api"
import { verifyAndreaniAuthentication } from "@/lib/andreani/client"
import { inspectArcaConfiguration } from "@/lib/arca/configuration"
import { getWsaaCredentials } from "@/lib/arca/wsaa"
import { feParamGetPtosVenta, getWsfeHealth } from "@/lib/arca/wsfe"
import {
  runSystemHealthChecks,
  systemHealthCache,
  systemHealthFingerprint,
  type SystemHealthDependencies,
} from "@/lib/admin/system-health-checks"
import { SYSTEM_HEALTH_POLL_MS, type SystemHealthResponse } from "@/lib/admin/system-health"
import { resolveTrustedSiteUrl } from "@/lib/site-url"

export const runtime = "nodejs"

function publicSettingsUrl() {
  const siteUrl = resolveTrustedSiteUrl()
  return siteUrl ? new URL("/api/store/settings", siteUrl).toString() : null
}

/**
 * Estado de integraciones de Admin > Dashboard. Sólo lectura: ver
 * lib/admin/system-health-checks.ts. `?force=1` ("Comprobar ahora") saltea el
 * cache compartido, con un intervalo mínimo entre comprobaciones forzadas.
 */
export async function GET(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const force = new URL(request.url).searchParams.get("force") === "1"
  const arca = inspectArcaConfiguration()
  const settingsUrl = publicSettingsUrl()
  const key = systemHealthFingerprint({ env: process.env, publicSettingsUrl: settingsUrl, arca })

  const deps: SystemHealthDependencies = {
    now: Date.now,
    store: {
      readDatabase: (signal) => auth.admin.from("productos").select("id").limit(1).abortSignal(signal),
      publicSettingsUrl: settingsUrl,
      fetch,
    },
    mercadoPago: { accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN, fetch },
    andreani: {
      env: process.env,
      verify: (timeoutMs) => verifyAndreaniAuthentication({ timeoutMs }),
    },
    arca: {
      inspect: () => arca,
      dummy: (signal) => getWsfeHealth(signal),
      authenticate: (configuration) => getWsaaCredentials(configuration),
      pointsOfSale: (signal) => feParamGetPtosVenta(signal),
    },
  }

  const { value, cached } = await systemHealthCache.get(key, () => runSystemHealthChecks(deps), { force })
  const body: SystemHealthResponse = {
    checks: value.checks,
    checkedAt: value.checkedAt,
    cached,
    pollAfterMs: SYSTEM_HEALTH_POLL_MS,
  }

  return Response.json(body, {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  })
}
