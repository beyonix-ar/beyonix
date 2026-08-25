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
  const requestInFlight = useRef(false)

  const loadStatus = useCallback(async () => {
    const token = await getAccessToken()
    if (!token) {
      setError("No se pudo validar la sesión administrativa.")
      return
    }

    try {
      const response = await fetch("/api/admin/integrations/andreani/test", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
      const payload = (await response.json()) as
        | AndreaniIntegrationStatus
        | { error?: string }

      if (!response.ok || !("configured" in payload)) {
        setError("No se pudo consultar el estado de Andreani.")
        return
      }

      setIntegration(payload)
      setError("")
    } catch {
      setError("No se pudo consultar el estado de Andreani.")
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

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
