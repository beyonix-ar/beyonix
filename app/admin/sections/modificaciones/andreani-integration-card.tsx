"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Cable, CheckCircle2, LoaderCircle, ShieldAlert } from "lucide-react"

import type {
  AndreaniConnectionTestResult,
  AndreaniIntegrationStatus,
} from "@/lib/andreani/types"
import { supabase } from "@/lib/supabase/client"
import {
  AdminCard,
  AdminInfoBlock,
  AdminPrimaryButton,
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
    <AdminCard className="space-y-4 p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="mb-1 text-xs font-black uppercase tracking-[0.16em] text-beyonix-cyan">
            Integraciones
          </p>
          <h2 className="flex items-center gap-2 text-base font-black text-white">
            <Cable className="size-4 text-beyonix-cyan" />
            Andreani
          </h2>
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm sm:min-w-80">
          <div className="rounded-xl bg-white/[0.035] px-3 py-2 ring-1 ring-inset ring-white/10">
            <span className="block text-xs font-bold text-white/46">Ambiente</span>
            <strong className="text-white">{integration?.environment ?? "—"}</strong>
          </div>
          <div className="rounded-xl bg-white/[0.035] px-3 py-2 ring-1 ring-inset ring-white/10">
            <span className="block text-xs font-bold text-white/46">Configuración</span>
            <strong
              className={
                integration?.configured ? "text-emerald-300" : "text-amber-200"
              }
            >
              {integration
                ? integration.configured
                  ? "Completa"
                  : "Incompleta"
                : "Consultando…"}
            </strong>
          </div>
        </div>
      </div>

      {lastTest ? (
        <AdminInfoBlock
          tone={lastTest.status === "success" ? "success" : "danger"}
          icon={
            lastTest.status === "success" ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <ShieldAlert className="size-4" />
            )
          }
        >
          <p className="font-bold">{lastTest.message}</p>
          <p className="mt-0.5 text-xs opacity-70">
            Última prueba: {new Date(lastTest.testedAt).toLocaleString("es-AR")}
          </p>
        </AdminInfoBlock>
      ) : integration ? (
        <AdminInfoBlock>{integration.message}</AdminInfoBlock>
      ) : null}

      {error ? <AdminInfoBlock tone="danger">{error}</AdminInfoBlock> : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-xs font-medium leading-5 text-white/50">
          La prueba solo autentica contra QA. No cotiza, no crea envíos y no expone
          credenciales ni tokens.
        </p>
        <AdminPrimaryButton
          type="button"
          onClick={() => void testConnection()}
          disabled={testing || !integration?.configured}
          className="shrink-0"
        >
          {testing ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Cable className="size-4" />
          )}
          {testing ? "Probando…" : "Probar conexión QA"}
        </AdminPrimaryButton>
      </div>
    </AdminCard>
  )
}
