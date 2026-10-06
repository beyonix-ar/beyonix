"use client"

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react"
import { CreditCard, ImageOff, ImageUp, Plus, RefreshCw, ToggleLeft, ToggleRight, Trash2 } from "lucide-react"

import { supabase } from "@/lib/supabase/client"
import {
  getPaymentTypeLabel,
  PAYMENT_LOGO_ACCEPT,
  PAYMENT_METHOD_NAME_MAX_LENGTH,
  type AdminPaymentMethodLogo,
  type AdminPaymentMethodsOverview,
  type PaymentMethodVisibility,
} from "@/lib/payments/payment-method-logos"
import { cn } from "@/lib/utils"
import {
  AdminGhostButton,
  AdminModal,
  AdminSecondaryButton,
  AdminTextInput,
} from "../../components/admin-controls"
import {
  ConfigChip,
  ConfigStat,
  ConfigStats,
  formatDateTime,
  type ConfigFeedback,
  type ConfigTone,
} from "../modificaciones/config-ui"

const API_BASE = "/api/admin/financiacion/medios-de-pago"

class PaymentMethodsRequestError extends Error {
  constructor(message: string, readonly overview: AdminPaymentMethodsOverview | null) {
    super(message)
  }
}

async function request(path: string, init: RequestInit = {}): Promise<AdminPaymentMethodsOverview> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) throw new PaymentMethodsRequestError("No se pudo validar la sesión.", null)
  const response = await fetch(path, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: { ...init.headers, Authorization: `Bearer ${session.access_token}` },
  })
  const data = (await response.json().catch(() => ({}))) as { paymentMethods?: AdminPaymentMethodsOverview; error?: string }
  if (!response.ok || !data.paymentMethods) {
    throw new PaymentMethodsRequestError(data.error ?? "No se pudo completar la operación.", data.paymentMethods ?? null)
  }
  return data.paymentMethods
}

const HIDDEN_REASONS: Record<Exclude<PaymentMethodVisibility, { visible: true }>["reason"], string> = {
  no_image: "Oculto: falta la imagen",
  disabled: "Oculto: inactivo en BEYONIX",
  provider_inactive: "Oculto: Mercado Pago lo informa no disponible",
  provider_missing: "Oculto: ya no figura en Mercado Pago",
  not_offered: "Oculto: el checkout no ofrece este tipo de pago",
}

function providerStatus(method: AdminPaymentMethodLogo): { tone: ConfigTone; label: string } | null {
  if (method.source !== "mercadopago") return null
  if (method.provider_status === "active") return { tone: "success", label: "Disponible en Mercado Pago" }
  if (method.provider_status === "inactive") return { tone: "danger", label: "No disponible en Mercado Pago" }
  return { tone: "warning", label: "Ya no figura en Mercado Pago" }
}

function LogoPreview({ method }: { method: AdminPaymentMethodLogo }) {
  return method.imageUrl ? (
    <span className="admin-payment-logo-tile flex h-11 w-[4.5rem] shrink-0 items-center justify-center overflow-hidden rounded-lg border p-1.5" data-logo-preview>
      {/* eslint-disable-next-line @next/next/no-img-element -- logo público de Storage, tamaño fijo */}
      <img src={method.imageUrl} alt={method.display_name} className="block size-full object-contain" />
    </span>
  ) : (
    <span className="admin-payment-logo-empty flex h-11 w-[4.5rem] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed text-10px font-bold" data-logo-empty>
      <ImageOff className="size-3.5" aria-hidden="true" />
      Sin imagen
    </span>
  )
}

function PaymentMethodRow({
  method,
  busy,
  onUpload,
  onRemoveImage,
  onToggle,
  onReviewed,
  onDelete,
}: {
  method: AdminPaymentMethodLogo
  busy: boolean
  onUpload: (file: File) => void
  onRemoveImage: () => void
  onToggle: () => void
  onReviewed: () => void
  onDelete: () => void
}) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const status = providerStatus(method)
  const visible = method.visibility.visible

  return (
    <li
      className="admin-payment-method-row grid gap-3 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
      data-payment-method={method.provider_method_id ?? method.id}
      data-source={method.source}
      data-visible={visible ? "true" : "false"}
    >
      <LogoPreview method={method} />

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-black text-white">{method.display_name}</p>
          {method.needs_review ? (
            <ConfigChip tone="info" data-new-method>Nuevo medio disponible</ConfigChip>
          ) : null}
        </div>
        <p className="mt-0.5 text-12px leading-4 text-white/66">
          {method.source === "mercadopago"
            ? `${method.provider_method_id} · ${method.provider_payment_types.map(getPaymentTypeLabel).join(", ") || "Sin tipo"}`
            : "Medio manual / externo · no se informa como medio de Mercado Pago"}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {status ? <ConfigChip tone={status.tone} data-provider-status={method.provider_status ?? undefined}>{status.label}</ConfigChip> : null}
          <ConfigChip tone={visible ? "success" : "neutral"} data-visibility>
            {visible ? "Visible para clientes" : HIDDEN_REASONS[method.visibility.reason]}
          </ConfigChip>
        </div>
        {method.needs_review && !method.image_path ? (
          <p className="mt-1.5 text-12px font-semibold leading-4 text-white/80" data-upload-hint>
            Cargá su imagen para mostrarlo a los clientes.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={PAYMENT_LOGO_ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ""
            if (file) onUpload(file)
          }}
          data-logo-input
        />
        <AdminSecondaryButton size="sm" disabled={busy} onClick={() => inputRef.current?.click()} data-logo-upload>
          <ImageUp className="size-3.5" aria-hidden="true" />
          {method.image_path ? "Reemplazar" : "Subir imagen"}
        </AdminSecondaryButton>
        {method.image_path ? (
          <AdminGhostButton size="sm" disabled={busy} onClick={onRemoveImage} data-logo-remove>
            Quitar imagen
          </AdminGhostButton>
        ) : null}
        <AdminSecondaryButton
          size="sm"
          aria-pressed={method.enabled}
          aria-label={method.enabled ? `${method.display_name}: activo en BEYONIX. Desactivar` : `${method.display_name}: inactivo en BEYONIX. Activar`}
          title={method.enabled ? "Activo en BEYONIX (se muestra si además tiene imagen y está disponible). Clic para desactivar." : "Inactivo en BEYONIX: nunca se muestra. Clic para activar."}
          disabled={busy}
          onClick={onToggle}
          className={cn("admin-toggle", method.enabled && "admin-toggle-on")}
          data-enabled-toggle
        >
          {method.enabled ? <ToggleRight className="admin-toggle-icon size-4" aria-hidden="true" /> : <ToggleLeft className="admin-toggle-icon size-4" aria-hidden="true" />}
          {method.enabled ? "Activo" : "Inactivo"}
        </AdminSecondaryButton>
        {method.needs_review ? (
          <AdminGhostButton size="sm" disabled={busy} onClick={onReviewed} data-mark-reviewed>
            Marcar revisado
          </AdminGhostButton>
        ) : null}
        {method.source === "manual" ? (
          confirmingDelete ? (
            <span className="flex items-center gap-1.5" data-delete-confirm>
              <AdminGhostButton size="sm" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                Cancelar
              </AdminGhostButton>
              <AdminSecondaryButton size="sm" disabled={busy} onClick={onDelete} className="admin-ds-button-destructive" data-delete-confirm-button>
                Eliminar
              </AdminSecondaryButton>
            </span>
          ) : (
            <AdminGhostButton size="sm" aria-label={`Eliminar ${method.display_name}`} disabled={busy} onClick={() => setConfirmingDelete(true)} data-delete>
              <Trash2 className="size-3.5" aria-hidden="true" />
            </AdminGhostButton>
          )
        ) : null}
      </div>
    </li>
  )
}

function PaymentMethodsManager({
  overview,
  loading,
  onChange,
}: {
  overview: AdminPaymentMethodsOverview | null
  loading: boolean
  onChange: (overview: AdminPaymentMethodsOverview) => void
}) {
  const [syncing, setSyncing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<ConfigFeedback | null>(null)
  const [manualName, setManualName] = useState("")
  const [creating, setCreating] = useState(false)

  const run = async (id: string | null, action: () => Promise<AdminPaymentMethodsOverview>, success: string): Promise<boolean> => {
    setBusyId(id)
    setFeedback(null)
    try {
      onChange(await action())
      setFeedback({ tone: "success", text: success })
      return true
    } catch (error) {
      if (error instanceof PaymentMethodsRequestError && error.overview) onChange(error.overview)
      setFeedback({ tone: "danger", text: error instanceof Error ? error.message : "No se pudo completar la operación." })
      return false
    } finally {
      setBusyId(null)
    }
  }

  const sync = async () => {
    if (syncing) return
    setSyncing(true)
    await run(null, () => request(`${API_BASE}/sync`, { method: "POST" }), "Medios de pago actualizados desde Mercado Pago.")
    setSyncing(false)
  }

  const patch = (method: AdminPaymentMethodLogo, body: Record<string, unknown>, success: string) =>
    run(method.id, () => request(`${API_BASE}/${method.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), success)

  const upload = (method: AdminPaymentMethodLogo, file: File) => {
    const form = new FormData()
    form.append("file", file)
    return run(method.id, () => request(`${API_BASE}/${method.id}/imagen`, { method: "POST", body: form }), "Imagen guardada.")
  }

  const createManual = async (event: FormEvent) => {
    event.preventDefault()
    const name = manualName.trim()
    if (!name || creating) return
    setCreating(true)
    const created = await run(null, () => request(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: name }),
    }), "Medio manual agregado. Cargá su imagen y activalo para mostrarlo.")
    if (created) setManualName("")
    setCreating(false)
  }

  const methods = overview?.methods ?? []
  const mercadoPago = methods.filter((method) => method.source === "mercadopago")
  const manual = methods.filter((method) => method.source === "manual")
  const newCount = mercadoPago.filter((method) => method.needs_review).length
  const syncState = overview?.sync ?? null
  const disabled = loading || overview === null

  const rowProps = (method: AdminPaymentMethodLogo) => ({
    method,
    busy: disabled || busyId === method.id || syncing,
    onUpload: (file: File) => void upload(method, file),
    onRemoveImage: () => void run(method.id, () => request(`${API_BASE}/${method.id}/imagen`, { method: "DELETE" }), "Imagen quitada. El medio ya no se muestra a los clientes."),
    onToggle: () => void patch(method, { enabled: !method.enabled }, method.enabled ? "Medio desactivado." : "Medio activado."),
    onReviewed: () => void patch(method, { reviewed: true }, "Medio marcado como revisado."),
    onDelete: () => void run(method.id, () => request(`${API_BASE}/${method.id}`, { method: "DELETE" }), "Medio manual eliminado."),
  })

  return (
    <div className="admin-payment-methods space-y-4" data-payment-methods-manager>
      <div className="admin-config-subpanel flex flex-wrap items-end justify-between gap-3 p-3">
        <ConfigStats className="grid-cols-2 gap-x-6">
          <ConfigStat
            label="Mercado Pago"
            tone={syncState?.lastError ? "danger" : syncState?.lastSuccessAt ? "success" : "info"}
            value={syncState?.lastError ? "No se pudo actualizar" : syncState?.lastSuccessAt ? "Sincronizado" : "Sin sincronizar"}
            data-sync-status={syncState?.lastError ? "failed" : syncState?.lastSuccessAt ? "synced" : "never"}
          />
          <ConfigStat
            label="Última sincronización"
            value={syncState?.lastSuccessAt ? formatDateTime(syncState.lastSuccessAt) : "Nunca"}
            data-last-sync
          />
        </ConfigStats>
        <AdminSecondaryButton size="sm" disabled={disabled || syncing} onClick={() => void sync()} data-sync-payment-methods>
          <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} aria-hidden="true" />
          {syncing ? "Actualizando…" : "Actualizar desde Mercado Pago"}
        </AdminSecondaryButton>
      </div>

      {syncState?.lastError ? (
        <p className="admin-config-status px-3 py-2 text-12px font-semibold leading-4 text-white/85" data-tone="danger" data-sync-error role="alert">
          {syncState.lastError} Se conserva el último estado conocido{syncState.lastSuccessAt ? ` (${formatDateTime(syncState.lastSuccessAt)})` : ""}.
        </p>
      ) : null}

      {feedback ? (
        <p role={feedback.tone === "danger" ? "alert" : "status"} className="admin-config-feedback text-12px font-semibold" data-tone={feedback.tone} data-payment-methods-feedback>
          {feedback.text}
        </p>
      ) : null}

      {newCount > 0 ? (
        <p className="admin-config-status px-3 py-2 text-12px font-semibold leading-4 text-white/85" data-tone="info" data-new-methods-alert>
          {newCount === 1 ? "Hay 1 nuevo medio disponible" : `Hay ${newCount} nuevos medios disponibles`} en Mercado Pago. Cargá su imagen para mostrarlo a los clientes.
        </p>
      ) : null}

      <section aria-labelledby="payment-methods-mp-title" data-payment-methods-section="mercadopago">
        <h3 id="payment-methods-mp-title" className="text-sm font-black text-white">Pagos disponibles en Mercado Pago</h3>
        <p className="mt-0.5 text-12px leading-4 text-white/66">
          Un logo se muestra a los clientes sólo si tiene imagen, está activo y Mercado Pago lo informa disponible.
          Si Mercado Pago lo quita o desactiva, se oculta solo y la imagen se conserva.
        </p>
        {mercadoPago.length ? (
          <ul className="admin-payment-method-list mt-2" data-payment-method-list="mercadopago">
            {mercadoPago.map((method) => <PaymentMethodRow key={method.id} {...rowProps(method)} />)}
          </ul>
        ) : (
          <p className="mt-2 text-12px font-semibold text-white/72" data-empty="mercadopago">
            {loading ? "Cargando…" : "Todavía no hay medios sincronizados. Usá “Actualizar desde Mercado Pago”."}
          </p>
        )}
      </section>

      <section aria-labelledby="payment-methods-manual-title" data-payment-methods-section="manual">
        <h3 id="payment-methods-manual-title" className="text-sm font-black text-white">Medios manuales / externos</h3>
        <p className="mt-0.5 text-12px leading-4 text-white/66">
          Para medios que no figuran en Mercado Pago (por ejemplo, MODO). Nunca se presentan como medios de Mercado Pago
          y sólo se muestran si los activás: hacelo únicamente si BEYONIX acepta ese medio.
        </p>
        <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => void createManual(event)} data-manual-form>
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <AdminTextInput
              title="Nombre del medio manual"
              placeholder="Ej.: MODO"
              value={manualName}
              maxLength={PAYMENT_METHOD_NAME_MAX_LENGTH}
              disabled={disabled || creating}
              onChange={setManualName}
            />
          </div>
          <AdminSecondaryButton type="submit" size="sm" disabled={disabled || creating || !manualName.trim()} data-manual-create>
            <Plus className="size-3.5" aria-hidden="true" />
            Agregar medio manual
          </AdminSecondaryButton>
        </form>
        {manual.length ? (
          <ul className="admin-payment-method-list mt-2" data-payment-method-list="manual">
            {manual.map((method) => <PaymentMethodRow key={method.id} {...rowProps(method)} />)}
          </ul>
        ) : null}
      </section>
    </div>
  )
}

/**
 * Admin → Financiación: botón discreto "MEDIOS DE PAGO DISPONIBLES" que abre
 * la gestión de logos. Lee el estado guardado al cargar (sin consultar
 * Mercado Pago) para avisar si hay medios nuevos sin imagen.
 */
export function PaymentMethodsButton() {
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<AdminPaymentMethodsOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError("")
    try {
      setOverview(await request(API_BASE))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "No se pudieron cargar los medios de pago.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const newCount = overview?.methods.filter((method) => method.needs_review).length ?? 0

  return (
    <>
      <AdminSecondaryButton size="sm" onClick={() => setOpen(true)} data-payment-methods-open className="whitespace-nowrap text-11px font-black uppercase leading-4 tracking-wide">
        <CreditCard className="size-3.5" aria-hidden="true" />
        Medios de pago disponibles
        {newCount > 0 ? (
          <span className="admin-config-chip text-10px leading-3.5 normal-case tracking-normal" data-tone="info" data-new-methods-count>
            {newCount} {newCount === 1 ? "nuevo" : "nuevos"}
          </span>
        ) : null}
      </AdminSecondaryButton>
      <AdminModal
        open={open}
        wide
        title="Medios de pago disponibles"
        description="Logos que ve el cliente, sincronizados con Mercado Pago."
        onClose={() => setOpen(false)}
      >
        {loadError ? (
          <p className="admin-config-status mb-3 px-3 py-2 text-12px font-semibold text-white/85" data-tone="danger" role="alert">
            {loadError}{" "}
            <button type="button" className="underline" onClick={() => void load()}>
              Reintentar
            </button>
          </p>
        ) : null}
        <PaymentMethodsManager overview={overview} loading={loading} onChange={setOverview} />
      </AdminModal>
    </>
  )
}
