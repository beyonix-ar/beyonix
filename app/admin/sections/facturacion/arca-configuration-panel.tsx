"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, LoaderCircle, PlugZap, XCircle } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import type { ArcaConfigurationStatus } from "@/lib/arca/configuration"
import type { ArcaAutoInvoicingView } from "@/lib/arca/auto-invoicing-control"
import {
  arcaCertificateLabel,
  arcaEnvironmentLabel,
} from "@/lib/arca/configuration-view"
import { ARCA_HOMOLOGATION_ENVIRONMENT_WARNING } from "@/lib/arca/environment"
import type { ArcaDiagnosticsReport } from "@/lib/arca/production-diagnostics"
import { AdminBadge, AdminInfoBlock, AdminModal, AdminSecondaryButton, adminSurfaceLevel } from "../../components/admin-controls"

async function adminFetch(path: string, init: RequestInit = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("La sesión administrativa venció.")

  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${session.access_token}`)
  return fetch(path, {
    ...init,
    signal: AbortSignal.timeout(init.method === "POST" ? 150_000 : 20_000),
    headers,
  })
}

/** Estado ARCA del servidor (sin secretos). Sin respuesta, la emisión se bloquea. */
export function useArcaConfigurationStatus() {
  const [status, setStatus] = useState<ArcaConfigurationStatus | null>(null)
  const [loadError, setLoadError] = useState("")

  const reload = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/arca/status")
      const data = (await response.json()) as { arca?: ArcaConfigurationStatus; error?: string }
      if (!response.ok || !data.arca) throw new Error(data.error || "Sin estado de ARCA.")
      setStatus(data.arca)
      setLoadError("")
    } catch (error) {
      setStatus(null)
      setLoadError(error instanceof Error ? error.message : "No se pudo verificar ARCA.")
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { status, loadError, reload }
}

function environmentTone(status: ArcaConfigurationStatus) {
  if (!status.configured) return "danger" as const
  return status.environment === "production" ? ("success" as const) : ("warning" as const)
}

function ConfigurationValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-11px font-bold uppercase tracking-wide text-white/42">{label}</p>
      <div className="mt-1 text-sm font-semibold text-white">{children}</div>
    </div>
  )
}

function formatActivationDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

export function ArcaConfigurationPanel({
  status,
  loadError,
  issueBlockReason,
}: {
  status: ArcaConfigurationStatus | null
  loadError: string
  issueBlockReason: string | null
}) {
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnostics, setDiagnostics] = useState<ArcaDiagnosticsReport | null>(null)
  const [diagnosticsError, setDiagnosticsError] = useState("")
  const [auto, setAuto] = useState<ArcaAutoInvoicingView | null>(null)
  const [autoError, setAutoError] = useState("")
  const [savingAuto, setSavingAuto] = useState(false)
  const [confirmActivation, setConfirmActivation] = useState(false)

  const loadAuto = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/arca/auto-invoicing")
      const data = (await response.json()) as { autoInvoicing?: ArcaAutoInvoicingView; error?: string }
      if (!response.ok || !data.autoInvoicing) throw new Error(data.error || "No se pudo consultar el control automático.")
      setAuto(data.autoInvoicing)
      setAutoError("")
    } catch (error) {
      setAuto(null)
      setAutoError(error instanceof Error ? error.message : "No se pudo consultar el control automático.")
    }
  }, [])

  useEffect(() => { void loadAuto() }, [loadAuto])

  const setAutomatic = async (enabled: boolean) => {
    if (savingAuto) return
    setSavingAuto(true)
    setAutoError("")
    try {
      const response = await adminFetch("/api/admin/arca/auto-invoicing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      })
      const data = (await response.json()) as { autoInvoicing?: ArcaAutoInvoicingView; error?: string }
      if (!response.ok || !data.autoInvoicing) throw new Error(data.error || "No se pudo cambiar la facturación automática.")
      setAuto(data.autoInvoicing)
      setConfirmActivation(false)
    } catch (error) {
      setAutoError(error instanceof Error ? error.message : "No se pudo cambiar la facturación automática.")
    } finally {
      setSavingAuto(false)
    }
  }

  const runDiagnostics = async () => {
    if (diagnosing) return
    setDiagnosing(true)
    setDiagnosticsError("")
    try {
      const response = await adminFetch("/api/admin/arca/diagnostics", { method: "POST" })
      const data = (await response.json()) as { diagnostics?: ArcaDiagnosticsReport; error?: string }
      if (!response.ok || !data.diagnostics) throw new Error(data.error || "No se pudo completar la verificación.")
      setDiagnostics(data.diagnostics)
    } catch (error) {
      setDiagnostics(null)
      setDiagnosticsError(error instanceof Error ? error.message : "No se pudo completar la verificación.")
    } finally {
      setDiagnosing(false)
    }
  }

  return (
    <section
      aria-label="Configuración ARCA"
      data-arca-configuration
      className="space-y-4"
    >
      <section data-arca-summary className={`${adminSurfaceLevel.section} rounded-2xl border border-white/10 bg-white/3 p-4 sm:p-5`}>
        <h2 className="mb-4 text-sm font-black text-white">Resumen ARCA</h2>
        {status ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <ConfigurationValue label="Ambiente ARCA">
              <AdminBadge tone={environmentTone(status)} data-arca-environment={arcaEnvironmentLabel(status)}>
                {arcaEnvironmentLabel(status)}
              </AdminBadge>
            </ConfigurationValue>
            <ConfigurationValue label="Punto de venta">
              {status.pointOfSaleConfigured ? status.pointOfSale : "Sin configurar"}
            </ConfigurationValue>
            <ConfigurationValue label="Certificado">{arcaCertificateLabel(status)}</ConfigurationValue>
            <ConfigurationValue label="Facturación automática">
              {auto ? (auto.enabled ? "Activa" : "Inactiva") : autoError ? "No disponible" : "Verificando..."}
              {auto?.controlEnabled && auto.cutoffAt && (
                <p className="mt-1 text-xs font-medium text-white/58">Pedidos elegibles desde: {formatActivationDate(auto.cutoffAt)}</p>
              )}
              {auto?.controlEnabled && !auto.enabled && (
                <p className="mt-1 text-xs font-medium text-amber-200">Control activo, interruptor del servidor apagado.</p>
              )}
            </ConfigurationValue>
          </div>
        ) : (
          <p className="text-sm text-white/60">
            {loadError ? "No se pudo verificar la configuración de ARCA." : "Verificando la configuración de ARCA..."}
          </p>
        )}

        {status?.configured && status.environment === "homologation" && (
          <AdminInfoBlock tone="warning" className="mt-4" icon={<AlertTriangle className="size-4" />} data-arca-homologation-warning>
            {ARCA_HOMOLOGATION_ENVIRONMENT_WARNING}
          </AdminInfoBlock>
        )}
        {issueBlockReason && (status || loadError) && (
          <AdminInfoBlock role="alert" tone="danger" className="mt-4" icon={<XCircle className="size-4" />} data-arca-issue-blocked>
            <p className="font-bold">No se pueden emitir comprobantes.</p>
            {status && !status.configured ? (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5">
                {status.errors.map((error) => <li key={error}>{error}</li>)}
              </ul>
            ) : <p className="mt-1 text-xs leading-5">{issueBlockReason}</p>}
          </AdminInfoBlock>
        )}

        <div className="mt-4 border-t border-white/8 pt-3">
          {!auto?.controlEnabled && (
            <p className="mb-2 max-w-3xl text-xs leading-5 text-white/58">
              La facturación automática se aplicará únicamente a pedidos elegibles posteriores a la fecha de activación. Los comprobantes históricos no se procesarán automáticamente.
            </p>
          )}
          {autoError && <p role="alert" className="mb-2 text-xs text-red-200">{autoError}</p>}
          {auto && (
            <AdminSecondaryButton
              size="sm"
              disabled={savingAuto || (!auto.controlEnabled && !auto.canActivate)}
              onClick={() => auto.controlEnabled ? void setAutomatic(false) : setConfirmActivation(true)}
            >
              {savingAuto ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {auto.controlEnabled ? "Desactivar automático" : "Activar automático"}
            </AdminSecondaryButton>
          )}
          {auto && !auto.controlEnabled && !auto.canActivate && (
            <p className="mt-2 text-xs text-white/50">La activación requiere ARCA PROD y el interruptor del servidor habilitado después de la primera factura manual.</p>
          )}
        </div>
      </section>

      <section data-arca-diagnostic-surface className={`${adminSurfaceLevel.section} rounded-2xl border border-white/10 bg-white/3 p-4 sm:p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-black text-white">Estado de conexión</h2>
          {status?.configured && (
            <AdminSecondaryButton size="sm" disabled={diagnosing} onClick={() => void runDiagnostics()}>
              {diagnosing ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
              {diagnosing ? "Verificando con ARCA..." : "Verificar conexión con ARCA (sin emitir)"}
            </AdminSecondaryButton>
          )}
        </div>
        {diagnosticsError && <p role="alert" className="mt-3 text-xs text-red-200/80">{diagnosticsError}</p>}
        {diagnostics ? (
          <ul className={`${adminSurfaceLevel.card} mt-4 grid gap-2 rounded-xl border border-white/8 bg-white/2 p-3 sm:grid-cols-2 xl:grid-cols-3`} data-arca-diagnostics>
            {diagnostics.steps.map((step) => (
              <li key={step.id} className="flex items-start gap-2 text-xs leading-5 text-white/78">
                {step.ok
                  ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400 dark:text-emerald-300" aria-label="Correcto" />
                  : <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-400" aria-label="Con error" />}
                <span><span className="font-bold text-white">{step.label}:</span> {step.detail}</span>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-xs text-white/55">Ejecutá la verificación para consultar el estado de los servicios ARCA.</p>}
      </section>

      {diagnostics && (
        <div
          data-arca-final-state
          role="status"
          className={`${adminSurfaceLevel.card} rounded-xl border px-4 py-3 text-sm font-semibold ${diagnostics.ok ? "border-emerald-400/20 bg-emerald-400/6 text-emerald-800 dark:text-emerald-100" : "border-red-400/20 bg-red-400/6 text-red-800 dark:text-red-100"}`}
        >
          {diagnostics.readyForFirstFiscalInvoice
            ? "Listo para emitir la primera Factura C fiscal (manual)."
            : diagnostics.ok
              ? "Conexión verificada en homologación: los comprobantes no tienen validez fiscal."
              : "La verificación no se completó: no emitas hasta resolver los errores."}
        </div>
      )}

      <AdminModal
        open={confirmActivation}
        title="Activar facturación automática"
        compact
        description="Confirmá la activación después de verificar la primera Factura C fiscal manual."
        onClose={() => setConfirmActivation(false)}
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <AdminSecondaryButton size="sm" onClick={() => setConfirmActivation(false)}>Cancelar</AdminSecondaryButton>
            <AdminSecondaryButton size="sm" disabled={savingAuto} onClick={() => void setAutomatic(true)}>Confirmar activación</AdminSecondaryButton>
          </div>
        }
      >
        <p className="text-sm leading-6 text-white/75">
          La facturación automática se aplicará únicamente a pedidos elegibles posteriores a la fecha de activación. Los comprobantes históricos no se procesarán automáticamente.
        </p>
      </AdminModal>
    </section>
  )
}
