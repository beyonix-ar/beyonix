import type { AnalyticsDateRange } from "@/lib/analytics/product-view-report"
import { supabase } from "@/lib/supabase/client"

async function getAuthHeaders(): Promise<Record<string, string> | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : null
}

/**
 * GET autenticado a un reporte de Admin > Analítica para un período. Lanza
 * con un mensaje para el usuario si falla (las tareas del ciclo global
 * informan así el error).
 */
export async function fetchAnalyticsReport<T>(
  path: string,
  range: AnalyticsDateRange,
  signal: AbortSignal,
  fallbackError: string,
): Promise<T> {
  const headers = await getAuthHeaders()
  if (!headers) throw new Error("Tu sesión expiró. Volvé a ingresar.")
  const response = await fetch(`${path}?from=${range.from}&to=${range.to}`, {
    headers,
    cache: "no-store",
    signal,
  })
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null
  if (!response.ok || !body || body.error) throw new Error(body?.error ?? fallbackError)
  return body
}
