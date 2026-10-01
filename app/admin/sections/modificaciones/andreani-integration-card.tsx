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
  AdminModal,
  AdminSecondaryButton,
} from "../../components/admin-controls"
import { ConfigSection, ConfigTile, formatDateTime } from "./config-ui"

async function getAccessToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  return session?.access_token ?? null
}

interface AndreaniIntegrationCardProps {
  /** Estado comercial guardado, leído por la pantalla de Configuración (null mientras carga). */
  commercialEnabled: boolean | null
}

export function AndreaniIntegrationCard({
  commercialEnabled: savedCommercialEnabled,
}: AndreaniIntegrationCardProps) {
  const [integration, setIntegration] = useState<AndreaniIntegrationStatus | null>(
    null,
  )
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState("")
  // Cambio confirmado en esta tarjeta; mientras no haya uno, manda lo guardado.
  const [toggledCommercialEnabled, setCommercialEnabled] = useState<boolean | null>(null)
  const commercialEnabled = toggledCommercialEnabled ?? savedCommercialEnabled
  const [togglingCommercial, setTogglingCommercial] = useState(false)
  const [confirmCommercial, setConfirmCommercial] = useState(false)
  const requestInFlight = useRef(false)

  const loadStatus = useCallback(async () => {
    try {
      const token = await getAccessToken()
      if (!token) {
        setError("No se pudo validar la sesión administrativa.")
        return
      }

      const integrationResponse = await fetch("/api/admin/integrations/andreani/test", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      })
      const payload = (await integrationResponse.json()) as
        | AndreaniIntegrationStatus
        | { error?: string }

      if (!integrationResponse.ok || !("configured" in payload)) {
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
      setConfirmCommercial(false)
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
  const shipmentCreation = integration?.shipmentCreation

  return (
    <ConfigSection
      icon={<Cable className="size-3.5" />}
      eyebrow="Integraciones"
      title="Andreani"
      description="Cotización, creación de envíos y seguimiento."
      actions={
        <AdminSecondaryButton
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
          {testing ? "Probando QA…" : "Probar conexión QA"}
        </AdminSecondaryButton>
      }
    >
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <ConfigTile
          label="Ambiente"
          tone={integration ? "info" : "neutral"}
          value={integration?.environment ?? "Consultando…"}
          detail="Cotización y seguimiento."
        />
        <ConfigTile
          label="Credenciales"
          tone={!integration ? "neutral" : integration.configured ? "success" : "warning"}
          value={!integration ? "Consultando…" : integration.configured ? "Configuradas" : "Incompletas"}
          detail={
            lastTest
              ? `Última prueba ${lastTest.environment}: ${lastTest.status === "success" ? "OK" : "con error"} · ${formatDateTime(lastTest.testedAt)}`
              : "Sin pruebas en esta sesión."
          }
        />
        <ConfigTile
          label="Venta con Andreani"
          tone={commercialEnabled === null ? "neutral" : commercialEnabled ? "success" : "warning"}
          value={commercialEnabled === null ? "Consultando…" : commercialEnabled ? "Activa" : "Desactivada"}
          detail={
            commercialEnabled === false
              ? "No se cotiza ni se crean envíos nuevos."
              : "Se cotiza y se crean envíos nuevos."
          }
          action={
            <AdminSecondaryButton
              type="button"
              size="sm"
              onClick={() => setConfirmCommercial(true)}
              disabled={togglingCommercial || commercialEnabled === null}
              className="w-full"
            >
              {togglingCommercial ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {commercialEnabled === false ? "Activar" : "Desactivar"}
            </AdminSecondaryButton>
          }
        />
        <ConfigTile
          label="Creación de envíos"
          tone={!shipmentCreation ? "neutral" : shipmentCreation.configured ? "success" : "danger"}
          value={
            !shipmentCreation
              ? "Consultando…"
              : `${shipmentCreation.environment} · ${shipmentCreation.configured ? "Lista" : "Bloqueada"}`
          }
          detail={shipmentCreation?.message}
        />
      </div>

      {lastTest ? (
        <p
          className={`mt-2.5 flex items-start gap-1.5 text-12px font-semibold leading-5 ${
            lastTest.status === "success" ? "text-emerald-200" : "text-red-200"
          }`}
        >
          {lastTest.status === "success" ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          )}
          {lastTest.message}
        </p>
      ) : null}

      <details className="admin-config-details mt-2.5 text-12px leading-5 text-white/62">
        <summary className="cursor-pointer font-bold text-white/72">Detalle de la integración</summary>
        <div className="mt-1.5 space-y-1">
          {integration?.message ? <p>{integration.message}</p> : null}
          <p>
            Andreani desactivado no afecta el seguimiento de envíos ya creados. La prueba de
            conexión verifica QA (pruebas); la creación en PROD requiere una prueba controlada
            con sus propias credenciales, contrato y sucursal, y un resultado QA exitoso no valida PROD.
          </p>
        </div>
      </details>
      <AdminModal open={confirmCommercial} title={commercialEnabled ? "Desactivar Andreani" : "Activar Andreani"} onClose={() => { if (!togglingCommercial) setConfirmCommercial(false) }} footer={<div className="flex gap-2"><AdminSecondaryButton disabled={togglingCommercial} onClick={() => setConfirmCommercial(false)}>Cancelar</AdminSecondaryButton><AdminPrimaryButton disabled={togglingCommercial} onClick={() => void toggleCommercialEnabled()}>{togglingCommercial ? "Guardando…" : "Confirmar cambio"}</AdminPrimaryButton></div>}>
        <p>{commercialEnabled ? "Se dejarán de ofrecer cotizaciones y crear envíos nuevos. El seguimiento de envíos existentes continuará funcionando." : "Se habilitarán cotizaciones y envíos nuevos con la configuración vigente. Verificá que el ambiente de creación indicado sea el esperado."}</p>
        {error && <p role="alert">{error}</p>}
      </AdminModal>

      {error ? (
        <AdminInfoBlock tone="danger" className="mt-2 py-2 text-xs">
          {error}
          <button type="button" onClick={() => void loadStatus()} className="ml-3 underline">Reintentar consulta</button>
        </AdminInfoBlock>
      ) : null}
    </ConfigSection>
  )
}
