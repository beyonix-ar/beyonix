"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, CheckCircle2, LoaderCircle, PlugZap, XCircle } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import type { ArcaConfigurationStatus } from "@/lib/arca/configuration"
import {
  arcaCertificateLabel,
  arcaEnvironmentLabel,
} from "@/lib/arca/configuration-view"
import { ARCA_HOMOLOGATION_ENVIRONMENT_WARNING } from "@/lib/arca/environment"
import type { ArcaDiagnosticsReport } from "@/lib/arca/production-diagnostics"
import { AdminBadge, AdminInfoBlock, AdminSecondaryButton } from "../../components/admin-controls"

async function adminFetch(path: string, init: RequestInit = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) throw new Error("La sesión administrativa venció.")

  return fetch(path, {
    ...init,
    signal: AbortSignal.timeout(init.method === "POST" ? 150_000 : 20_000),
    headers: { Authorization: `Bearer ${session.access_token}` },
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
      className="rounded-2xl border border-white/8 bg-white/3 p-4"
    >
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
            {status.autoInvoicingEnabled ? "Activa" : "Inactiva"}
          </ConfigurationValue>
        </div>
      ) : (
        <p className="text-sm text-white/60">
          {loadError ? "No se pudo verificar la configuración de ARCA." : "Verificando la configuración de ARCA..."}
        </p>
      )}

      {status?.configured && status.environment === "homologation" && (
        <AdminInfoBlock
          tone="warning"
          className="mt-4"
          icon={<AlertTriangle className="size-4" />}
          data-arca-homologation-warning
        >
          {ARCA_HOMOLOGATION_ENVIRONMENT_WARNING}
        </AdminInfoBlock>
      )}

      {issueBlockReason && (status || loadError) && (
        <AdminInfoBlock
          role="alert"
          tone="danger"
          className="mt-4"
          icon={<XCircle className="size-4" />}
          data-arca-issue-blocked
        >
          <p className="font-bold">No se pueden emitir comprobantes.</p>
          {status && !status.configured ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs leading-5">
              {status.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs leading-5">{issueBlockReason}</p>
          )}
        </AdminInfoBlock>
      )}

      {status?.configured && (
        <div className="mt-4">
          <AdminSecondaryButton size="sm" disabled={diagnosing} onClick={() => void runDiagnostics()}>
            {diagnosing ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            {diagnosing ? "Verificando con ARCA..." : "Verificar conexión con ARCA (sin emitir)"}
          </AdminSecondaryButton>
          {diagnosticsError && (
            <p role="alert" className="mt-2 text-xs text-red-200/80">{diagnosticsError}</p>
          )}
          {diagnostics && (
            <ul className="mt-3 space-y-1.5" data-arca-diagnostics>
              {diagnostics.steps.map((step) => (
                <li key={step.id} className="flex items-start gap-2 text-xs leading-5 text-white/78">
                  {step.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-label="Correcto" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-red-300" aria-label="Con error" />
                  )}
                  <span>
                    <span className="font-bold text-white">{step.label}:</span> {step.detail}
                  </span>
                </li>
              ))}
              <li className="pt-1 text-xs font-bold text-white">
                {diagnostics.readyForFirstFiscalInvoice
                  ? "Listo para emitir la primera Factura C fiscal (manual)."
                  : diagnostics.ok
                    ? "Conexión verificada en homologación: los comprobantes no tienen validez fiscal."
                    : "La verificación no se completó: no emitas hasta resolver los errores."}
              </li>
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
