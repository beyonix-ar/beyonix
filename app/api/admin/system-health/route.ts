import { requireInternalUser } from "@/lib/auth/admin-api"
import { getAndreaniConfig, isAndreaniReady } from "@/lib/andreani/client"
import { getWsfeHealth } from "@/lib/arca/wsfe"

type HealthStatus = "ok" | "warning" | "error" | "disabled" | "unknown"

interface HealthResult {
  id: "store" | "mercadopago" | "andreani" | "arca"
  label: string
  status: HealthStatus
  detail: string
  checkedAt: string
  latencyMs: number | null
  verified: boolean
}

const HEALTH_TIMEOUT_MS = 5_000

function elapsed(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

async function withHealthTimeout<T>(
  promise: Promise<T>,
  timeoutMessage: string,
) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(timeoutMessage)),
          HEALTH_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function result(
  item: Omit<HealthResult, "checkedAt">,
): HealthResult {
  return {
    ...item,
    checkedAt: new Date().toISOString(),
  }
}

async function checkStore(
  databaseCheck: PromiseLike<unknown>,
): Promise<HealthResult> {
  const startedAt = performance.now()

  try {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
    const publicSettingsUrl = siteUrl
      ? new URL("/api/store/settings", siteUrl)
      : null
    const [databaseResult, publicApiResult] = await withHealthTimeout(
      Promise.allSettled([
        Promise.resolve(databaseCheck),
        publicSettingsUrl
          ? fetch(publicSettingsUrl, {
              cache: "no-store",
              headers: { "x-health-check": "dashboard" },
              signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS - 250),
            })
          : Promise.reject(
              new Error("NEXT_PUBLIC_SITE_URL no está configurada."),
            ),
      ]),
      "La verificación de la tienda superó el tiempo límite.",
    )

    const databaseError =
      databaseResult.status === "rejected"
        ? databaseResult.reason
        : (databaseResult.value as { error?: { message?: string } | null })
            ?.error
    const publicApiOk =
      publicApiResult.status === "fulfilled" && publicApiResult.value.ok

    if (databaseError || !publicApiOk) {
      return result({
        id: "store",
        label: "Tienda y base de datos",
        status: "error",
        detail: databaseError
          ? "La base de datos no respondió correctamente."
          : `La API pública respondió HTTP ${
              publicApiResult.status === "fulfilled"
                ? publicApiResult.value.status
                : "sin respuesta"
            }.`,
        latencyMs: elapsed(startedAt),
        verified: true,
      })
    }

    return result({
      id: "store",
      label: "Tienda y base de datos",
      status: "ok",
      detail: "API pública y base de datos respondieron correctamente.",
      latencyMs: elapsed(startedAt),
      verified: true,
    })
  } catch (error) {
    return result({
      id: "store",
      label: "Tienda y base de datos",
      status: "error",
      detail:
        error instanceof Error
          ? error.message
          : "No se pudo verificar la tienda.",
      latencyMs: elapsed(startedAt),
      verified: true,
    })
  }
}

async function checkMercadoPago(): Promise<HealthResult> {
  const startedAt = performance.now()
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN

  if (!token) {
    return result({
      id: "mercadopago",
      label: "Mercado Pago",
      status: "disabled",
      detail: "No hay credenciales configuradas.",
      latencyMs: null,
      verified: true,
    })
  }

  try {
    const response = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })

    return result({
      id: "mercadopago",
      label: "Mercado Pago",
      status: response.ok ? "ok" : "error",
      detail: response.ok
        ? "La API autenticada respondió correctamente."
        : `La API autenticada respondió HTTP ${response.status}.`,
      latencyMs: elapsed(startedAt),
      verified: true,
    })
  } catch (error) {
    return result({
      id: "mercadopago",
      label: "Mercado Pago",
      status: "error",
      detail:
        error instanceof Error
          ? `No respondió: ${error.message}`
          : "La API no respondió.",
      latencyMs: elapsed(startedAt),
      verified: true,
    })
  }
}

function checkAndreani(): HealthResult {
  const config = getAndreaniConfig()
  const ready = isAndreaniReady(config)

  if (!config.enabled) {
    return result({
      id: "andreani",
      label: "Andreani",
      status: "disabled",
      detail: "Integración deshabilitada; no se realizan envíos por Andreani.",
      latencyMs: null,
      verified: true,
    })
  }

  return result({
    id: "andreani",
    label: "Andreani",
    status: ready ? "warning" : "error",
    detail: ready
      ? "Configurada, pero la integración todavía no dispone de una prueba operativa real."
      : "Integración habilitada con configuración incompleta.",
    latencyMs: null,
    verified: false,
  })
}

async function checkArca(): Promise<HealthResult> {
  const startedAt = performance.now()

  try {
    const health = await withHealthTimeout(
      getWsfeHealth(),
      "ARCA superó el tiempo límite de respuesta.",
    )
    const values = [health.appServer, health.dbServer, health.authServer]
    const allOk = values.every((value) => value === "OK")

    return result({
      id: "arca",
      label: "ARCA / Facturación electrónica",
      status: allOk ? "ok" : "warning",
      detail: allOk
        ? "FEDummy verificó aplicación, base de datos y autenticación."
        : `FEDummy: aplicación ${health.appServer || "-"}, base ${
            health.dbServer || "-"
          }, autenticación ${health.authServer || "-"}.`,
      latencyMs: elapsed(startedAt),
      verified: true,
    })
  } catch (error) {
    return result({
      id: "arca",
      label: "ARCA / Facturación electrónica",
      status: "error",
      detail:
        error instanceof Error
          ? error.message
          : "ARCA no respondió a la verificación.",
      latencyMs: elapsed(startedAt),
      verified: true,
    })
  }
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const checks = await Promise.all([
    checkStore(
      auth.admin.from("productos").select("id").limit(1),
    ),
    checkMercadoPago(),
    Promise.resolve(checkAndreani()),
    checkArca(),
  ])

  return Response.json(
    {
      checks,
      checkedAt: new Date().toISOString(),
      pollAfterMs: 30_000,
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  )
}
