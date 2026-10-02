"use client"

import { useCallback, useEffect, useState } from "react"

import { supabase } from "@/lib/supabase/client"
import type { MercadoPagoCostsOverview, StoredInstallmentsFinancingSettings } from "@/lib/site-settings"
import { invalidateSiteSettingsClientCache } from "@/hooks/use-site-settings"
import { AdminInfoBlock, AdminPageHeader } from "../../components/admin-controls"
import type { ConfigFeedback } from "../modificaciones/config-ui"
import { FinancingPanel } from "./financing-panel"

interface SettingsResponse {
  mercadoPagoCosts?: MercadoPagoCostsOverview
  error?: string
}

async function getAccessToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? null
}

/** Error de la API que igual trae el estado actualizado (p. ej. Mercado Pago no respondió). */
class FinancingRequestError extends Error {
  constructor(message: string, readonly overview: MercadoPagoCostsOverview | null) {
    super(message)
  }
}

async function request(path: string, init: RequestInit = {}) {
  const token = await getAccessToken()
  if (!token) throw new Error("No se pudo validar la sesión.")
  const response = await fetch(path, {
    ...init,
    signal: AbortSignal.timeout(45_000),
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  })
  const data = (await response.json()) as SettingsResponse
  if (!response.ok || !data.mercadoPagoCosts) {
    throw new FinancingRequestError(data.error ?? "No se pudo completar la operación.", data.mercadoPagoCosts ?? null)
  }
  return data.mercadoPagoCosts
}

const SAVED_MESSAGE = "Guardado. Los precios y el checkout ya usan estos valores."

/**
 * Admin → Financiación: centro de control de costos de Mercado Pago, cuotas
 * sin interés (ON/OFF; lo que se ofrece lo decide Mercado Pago) y
 * aprendizaje automático. Lee y guarda por
 * la misma API de configuración (`installmentsFinancing`), sin duplicar lógica.
 */
export function AdminFinanciacion() {
  const [overview, setOverview] = useState<MercadoPagoCostsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [saving, setSaving] = useState(false)
  const [checkingReference, setCheckingReference] = useState(false)
  const [feedback, setFeedback] = useState<ConfigFeedback | null>(null)
  // El panel edita un borrador propio; al cargar o guardar se reinicia con
  // los valores confirmados por el servidor.
  const [version, setVersion] = useState(0)


  const load = useCallback(async () => {
    setLoading(true)
    setLoadError("")
    try {
      setOverview(await request("/api/admin/settings"))
      setFeedback(null)
      setVersion((current) => current + 1)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "No se pudo cargar la financiación.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (installmentsFinancing: StoredInstallmentsFinancingSettings) => {
    if (saving || loading || !overview) return
    setSaving(true)
    setFeedback(null)
    try {
      const next = await request("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installmentsFinancing }),
      })
      invalidateSiteSettingsClientCache()
      setOverview(next)
      setVersion((current) => current + 1)
      setFeedback({ tone: "success", text: SAVED_MESSAGE })
    } catch (error) {
      setFeedback({
        tone: "danger",
        text: error instanceof Error ? error.message : "No se pudo guardar. Recargá antes de reintentar.",
      })
    } finally {
      setSaving(false)
    }
  }

  // Sólo cambia la sincronización con Mercado Pago: el borrador en edición se conserva.
  const applySync = (next: MercadoPagoCostsOverview) =>
    setOverview((current) =>
      current
        ? { ...current, interestFreeStatus: next.interestFreeStatus, interestFreeOffer: next.interestFreeOffer }
        : next,
    )

  const checkReference = async () => {
    if (checkingReference) return
    setCheckingReference(true)
    setFeedback(null)
    try {
      const next = await request("/api/admin/financiacion/referencia-mercadopago", { method: "POST" })
      applySync(next)
      setFeedback({ tone: "success", text: "Mercado Pago sincronizado." })
    } catch (error) {
      // Aun fallando, el estado (hora y motivo del fallo) se muestra en pantalla.
      if (error instanceof FinancingRequestError && error.overview) applySync(error.overview)
      setFeedback({
        tone: "danger",
        text: error instanceof Error ? error.message : "No se pudo comprobar Mercado Pago.",
      })
    } finally {
      setCheckingReference(false)
    }
  }

  return (
    <div className="admin-config-page admin-financing-page space-y-3 p-4 sm:p-6 lg:p-8">
      <AdminPageHeader
        title="Financiación"
        description="Cuotas sin interés y costos de Mercado Pago."
        className="gap-2"
      />

      {loadError ? (
        <AdminInfoBlock tone="danger" className="py-2 text-xs">
          {loadError}
          <button type="button" disabled={loading} onClick={() => void load()} className="ml-3 underline">
            Reintentar
          </button>
        </AdminInfoBlock>
      ) : null}

      <FinancingPanel
        key={version}
        overview={overview}
        // Sin el estado real nunca se guardan defaults encima.
        disabled={loading || overview === null}
        saving={saving}
        checkingReference={checkingReference}
        feedback={feedback}
        onSave={(value) => void save(value)}
        onCheckReference={() => void checkReference()}
      />
    </div>
  )
}
