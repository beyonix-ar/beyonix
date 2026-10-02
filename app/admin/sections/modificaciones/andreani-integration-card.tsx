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
import { ConfigDisclosure, ConfigSection, ConfigValueList, ConfigValueRow, formatDateTime } from "./config-ui"

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
      title="Andreani"
      data-config-block="andreani"
    >
      <ConfigValueList>
        <ConfigValueRow label="Ambiente" tone={integration ? "info" : "neutral"}>
          {integration?.environment ?? "Consultando…"}
        </ConfigValueRow>
        <ConfigValueRow label="Credenciales" tone={!integration ? "neutral" : integration.configured ? "success" : "warning"}>
          {!integration ? "Consultando…" : integration.configured ? "Configuradas" : "Incompletas"}
        </ConfigValueRow>
        <ConfigValueRow
          label="Venta"
          tone={commercialEnabled === null ? "neutral" : commercialEnabled ? "success" : "warning"}
          data-andreani-commercial={commercialEnabled === null ? "loading" : commercialEnabled ? "active" : "inactive"}
        >
          {commercialEnabled === null ? "Consultando…" : commercialEnabled ? "Activa" : "Desactivada"}
        </ConfigValueRow>
        <ConfigValueRow
          label="Creación de envíos"
          tone={!shipmentCreation ? "neutral" : shipmentCreation.configured ? "success" : "danger"}
        >
          {!shipmentCreation
            ? "Consultando…"
            : `${shipmentCreation.environment} · ${shipmentCreation.configured ? "Lista" : "Bloqueada"}`}
        </ConfigValueRow>
      </ConfigValueList>

      <div className="mt-2 flex flex-wrap gap-2" data-andreani-actions>
        <AdminSecondaryButton
          type="button"
          size="sm"
          onClick={() => void testConnection()}
          disabled={testing || !integration?.configured}
        >
          {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Cable className="size-3.5" />}
          {testing ? "Probando QA…" : "Probar conexión QA"}
        </AdminSecondaryButton>
        <AdminSecondaryButton
          type="button"
          size="sm"
          data-andreani-commercial-toggle
          onClick={() => setConfirmCommercial(true)}
          disabled={togglingCommercial || commercialEnabled === null}
        >
          {togglingCommercial ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {commercialEnabled === false ? "Activar venta" : "Desactivar venta"}
        </AdminSecondaryButton>
      </div>

      {lastTest ? (
        <p
          className="admin-config-feedback mt-2 flex items-start gap-1.5 text-12px font-semibold leading-5"
          data-tone={lastTest.status === "success" ? "success" : "danger"}
          data-andreani-last-test
        >
          {lastTest.status === "success" ? (
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          )}
          Prueba {lastTest.environment} {lastTest.status === "success" ? "OK" : "con error"} · {formatDateTime(lastTest.testedAt)}
        </p>
      ) : null}

      <ConfigDisclosure summary="Ver detalle de integración" className="mt-2" data-andreani-detail>
        {integration?.message ? <p>{integration.message}</p> : null}
        {shipmentCreation?.message ? <p>Creación de envíos: {shipmentCreation.message}</p> : null}
        {lastTest ? <p>Última prueba: {lastTest.message}</p> : <p>Sin pruebas de conexión en esta sesión.</p>}
        <p>
          {commercialEnabled === false
            ? "Venta desactivada: no se cotiza ni se crean envíos nuevos."
            : "Venta activa: se cotiza y se crean envíos nuevos."}{" "}
          Desactivarla no afecta el seguimiento de envíos ya creados.
        </p>
        <p>
          La prueba de conexión verifica QA. La creación en PROD requiere una prueba controlada con sus
          propias credenciales, contrato y sucursal: un resultado QA exitoso no valida PROD.
        </p>
      </ConfigDisclosure>
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
