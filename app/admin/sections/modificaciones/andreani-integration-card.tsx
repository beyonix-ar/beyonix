"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Cable, CheckCircle2, LoaderCircle, ShieldAlert } from "lucide-react"

import type {
  AndreaniConnectionTestResult,
  AndreaniIntegrationStatus,
} from "@/lib/andreani/types"
import { supabase } from "@/lib/supabase/client"
import {
  AdminInfoBlock,
  AdminPrimaryButton,
  AdminSection,
  AdminStatusIndicator,
} from "../../components/admin-controls"

async function getAccessToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? null
}

export function AndreaniIntegrationCard() {
  const [integration, setIntegration] = useState<AndreaniIntegrationStatus | null>(
    null,
  )
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState("")
  const [commercialEnabled, setCommercialEnabled] = useState<boolean | null>(null)
  const [togglingCommercial, setTogglingCommercial] = useState(false)
  const requestInFlight = useRef(false)

  const loadStatus = useCallback(async () => {
    const token = await getAccessToken()
    if (!token) {
      setError("No se pudo validar la sesión administrativa.")
      return
    }

    try {
      const [integrationResponse, settingsResponse] = await Promise.all([
        fetch("/api/admin/integrations/andreani/test", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        }),
        fetch("/api/admin/settings", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        }),
      ])
      const payload = (await integrationResponse.json()) as
        | AndreaniIntegrationStatus
        | { error?: string }

      if (!integrationResponse.ok || !("configured" in payload)) {
        setError("No se pudo consultar el estado de Andreani.")
        return
      }

      setIntegration(payload)
      setError("")

      if (settingsResponse.ok) {
        const settingsPayload = (await settingsResponse.json()) as {
          settings?: { andreaniCommercial?: { enabled?: boolean } }
        }
        const enabled = settingsPayload.settings?.andreaniCommercial?.enabled
        if (typeof enabled === "boolean") setCommercialEnabled(enabled)
      }
    } catch {
      setError("No se pudo consultar el estado de Andreani.")
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const toggleCommercialEnabled = async () => {
    if (togglingCommercial || commercialEnabled === null) return
    setTogglingCommercial(true)
    setError("")

    try {
      const token = await getAccessToken()
      if (!token) {
        setError("No se pudo validar la sesión administrativa.")
        return
      }

      const nextEnabled = !commercialEnabled
      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ andreaniCommercial: { enabled: nextEnabled } }),
      })

      if (!response.ok) {
        setError("No se pudo actualizar la disponibilidad comercial de Andreani.")
        return
      }

      setCommercialEnabled(nextEnabled)
    } catch {
      setError("No se pudo actualizar la disponibilidad comercial de Andreani.")
    } finally {
      setTogglingCommercial(false)
    }
  }

  const testConnection = async () => {
    if (requestInFlight.current || testing) return
    requestInFlight.current = true
    setTesting(true)
    setError("")

    try {
      const token = await getAccessToken()
      if (!token) {
        setError("No se pudo validar la sesión administrativa.")
        return
      }

      const response = await fetch("/api/admin/integrations/andreani/test", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      })
      const result = (await response.json()) as AndreaniConnectionTestResult

      if (
        (result.status !== "success" && result.status !== "error") ||
        result.environment !== "QA"
      ) {
        setError("La prueba devolvió una respuesta inválida.")
        return
      }

      setIntegration((current) =>
        current ? { ...current, lastTest: result } : current,
      )
    } catch {
      setError("No se pudo ejecutar la prueba de conexión.")
    } finally {
      requestInFlight.current = false
      setTesting(false)
    }
  }

  const lastTest = integration?.lastTest

  return (
    <AdminSection
      compact
      icon={<Cable className="size-3.5" />}
      eyebrow="Integraciones"
      title="Andreani"
      description="Integración logística."
      actions={
        <div className="flex items-center gap-3">
          <div className="text-right leading-tight">
            <span className="block text-11px font-black uppercase tracking-widest text-white/45">
              Ambiente
            </span>
            <strong className="text-sm font-black text-white">
              {integration?.environment ?? "—"}
            </strong>
          </div>
          <span className="hidden h-8 w-px shrink-0 bg-white/10 sm:block" />
          <AdminStatusIndicator
            tone={
              !integration
                ? "neutral"
                : integration.configured
                  ? "success"
                  : "warning"
            }
          >
            {integration
              ? integration.configured
                ? "Configurado"
                : "Incompleto"
              : "Consultando…"}
          </AdminStatusIndicator>
          <AdminPrimaryButton
            type="button"
            size="sm"
            onClick={() => void testConnection()}
            disabled={testing || !integration?.configured}
            className="shrink-0"
          >
            {testing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Cable className="size-3.5" />
            )}
            {testing ? "Probando…" : "Probar conexión"}
          </AdminPrimaryButton>
        </div>
      }
    >
      {lastTest ? (
        <AdminInfoBlock
          tone={lastTest.status === "success" ? "success" : "danger"}
          icon={
            lastTest.status === "success" ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <ShieldAlert className="size-3.5" />
            )
          }
          className="py-2 text-xs"
        >
          <p className="font-bold">{lastTest.message}</p>
          <p className="mt-0.5 text-12px opacity-70">
            Última prueba: {new Date(lastTest.testedAt).toLocaleString("es-AR")}
          </p>
        </AdminInfoBlock>
      ) : integration ? (
        <AdminInfoBlock className="py-2 text-xs">
          {integration.message}
        </AdminInfoBlock>
      ) : null}

      <AdminInfoBlock
        tone={commercialEnabled === false ? "warning" : "success"}
        icon={
          commercialEnabled === false ? (
            <ShieldAlert className="size-3.5" />
          ) : (
            <CheckCircle2 className="size-3.5" />
          )
        }
        className="mt-2 flex items-center justify-between gap-3 py-2 text-xs"
      >
        <div>
          <p className="font-bold">
            {commercialEnabled === false
              ? "Andreani desactivado comercialmente"
              : "Andreani activo comercialmente"}
          </p>
          <p className="mt-0.5 text-12px opacity-70">
            {commercialEnabled === false
              ? "No se cotiza ni se crean envíos nuevos. El tracking de envíos ya creados sigue funcionando igual."
              : "Se cotiza y se pueden crear envíos nuevos con la configuración vigente."}
          </p>
        </div>
        <AdminPrimaryButton
          type="button"
          size="sm"
          onClick={() => void toggleCommercialEnabled()}
          disabled={togglingCommercial || commercialEnabled === null}
          className="shrink-0"
        >
          {togglingCommercial ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : null}
          {commercialEnabled === false ? "Activar" : "Desactivar"}
        </AdminPrimaryButton>
      </AdminInfoBlock>

      {integration?.shipmentCreation ? (
        <AdminInfoBlock
          tone={integration.shipmentCreation.configured ? "success" : "danger"}
          icon={
            integration.shipmentCreation.configured ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <ShieldAlert className="size-3.5" />
            )
          }
          className="mt-2 py-2 text-xs"
        >
          <p className="font-bold">
            Creación de envíos ({integration.shipmentCreation.environment})
          </p>
          <p className="mt-0.5 text-12px opacity-70">
            {integration.shipmentCreation.message}
          </p>
        </AdminInfoBlock>
      ) : null}

      {error ? (
        <AdminInfoBlock tone="danger" className="mt-2 py-2 text-xs">
          {error}
        </AdminInfoBlock>
      ) : null}
    </AdminSection>
  )
}
