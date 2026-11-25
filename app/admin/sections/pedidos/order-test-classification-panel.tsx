"use client"

import { useRef, useState } from "react"
import { FlaskConical, RefreshCw } from "lucide-react"

import { notifyAdminNotificationsChanged } from "@/lib/admin/admin-notifications"
import {
  hasUnsupportedRestock,
  isTestOrderConfirmationValid,
  isTestOrderReasonValid,
  pendingRestockUnits,
  TEST_ORDER_REASON_MAX,
  TEST_ORDER_REASON_MIN,
  testOrderConfirmationText,
  type TestOrderRestockPlanItem,
} from "@/lib/orders/test-order-classification"
import { supabase } from "@/lib/supabase/client"
import type { SupabasePedido } from "@/lib/supabase/types"
import { AdminButton, AdminModal, AdminSecondaryButton, AdminTextarea, AdminTextInput } from "../../components/admin-controls"

function formatDateTime(value?: string | null) {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(date)
}

function unitsLabel(units: number) {
  return `${units} ${units === 1 ? "unidad" : "unidades"}`
}

interface Preview {
  reasons: string[]
  restockPlan: TestOrderRestockPlanItem[]
}

interface ClassificationResult {
  test_order_at?: string | null
  test_order_by?: string | null
  test_order_reason?: string | null
  archived_at?: string | null
  archived_by?: string | null
  archive_reason?: string | null
  customer_hidden_at?: string | null
}

/**
 * "Clasificar como compra de prueba" (sólo super_admin). Saca el pedido de
 * las estadísticas comerciales, lo archiva y, si se elige, reingresa al stock
 * las unidades que siguen descontadas. Pago y factura no se tocan. La base
 * revalida todo y deja la auditoría; el panel sólo guía la decisión.
 */
export function OrderTestClassificationPanel({
  pedido,
  onUpdated,
}: {
  pedido: SupabasePedido
  onUpdated: (order: SupabasePedido) => void
}) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [reason, setReason] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [restock, setRestock] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const inFlight = useRef(false)
  const classified = Boolean(pedido.test_order_at)
  const expectedConfirmation = testOrderConfirmationText(pedido.id)

  const request = async (method: "GET" | "POST", body?: object) => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) throw new Error("La sesión administrativa venció.")
    const response = await fetch(`/api/admin/orders/${pedido.id}/test-classification`, {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = (await response.json().catch(() => null)) as {
      error?: string
      reasons?: string[]
      restockPlan?: TestOrderRestockPlanItem[]
      classification?: ClassificationResult
    } | null
    return { ok: response.ok, data }
  }

  const openModal = async () => {
    if (inFlight.current) return
    setOpen(true)
    setPreview(null)
    setReason("")
    setConfirmation("")
    setError("")
    inFlight.current = true
    setBusy(true)
    try {
      const { ok, data } = await request("GET")
      if (!ok) throw new Error(data?.error ?? "No se pudo comprobar el pedido.")
      const plan = data?.restockPlan ?? []
      setPreview({ reasons: data?.reasons ?? [], restockPlan: plan })
      setRestock(pendingRestockUnits(plan) > 0 && !hasUnsupportedRestock(plan))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo comprobar el pedido.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const trimmedReason = reason.trim()
  const pendingUnits = preview ? pendingRestockUnits(preview.restockPlan) : 0
  const unsupported = preview ? hasUnsupportedRestock(preview.restockPlan) : false
  const ready =
    preview !== null &&
    preview.reasons.length === 0 &&
    isTestOrderReasonValid(trimmedReason) &&
    isTestOrderConfirmationValid(pedido.id, confirmation)

  const submit = async () => {
    if (!ready || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError("")
    try {
      const { ok, data } = await request("POST", {
        reason: trimmedReason,
        confirmation: confirmation.trim(),
        restock: restock && pendingUnits > 0 && !unsupported,
      })
      if (!ok) {
        if (data?.reasons?.length && preview) setPreview({ ...preview, reasons: data.reasons })
        throw new Error(data?.error ?? "No se pudo clasificar el pedido como prueba.")
      }
      const result = data?.classification ?? {}
      onUpdated({
        ...pedido,
        test_order_at: result.test_order_at ?? null,
        test_order_by: result.test_order_by ?? null,
        test_order_reason: result.test_order_reason ?? null,
        archived_at: result.archived_at ?? pedido.archived_at ?? null,
        archived_by: result.archived_by ?? pedido.archived_by ?? null,
        archive_reason: result.archive_reason ?? pedido.archive_reason ?? null,
        customer_hidden_at: result.customer_hidden_at ?? pedido.customer_hidden_at ?? null,
      })
      setOpen(false)
      notifyAdminNotificationsChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la acción.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section className="admin-order-data-panel rounded-xl border p-3" aria-label="Compra de prueba" data-testid="order-test-classification-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-sm">
          <h3 className="font-black text-[var(--admin-text)]">{classified ? "Compra de prueba" : "Compra de prueba interna"}</h3>
          <p className="mt-1 leading-6 text-[var(--admin-text-soft)]">
            {classified
              ? `Clasificada el ${formatDateTime(pedido.test_order_at)}: ${pedido.test_order_reason ?? ""}. Fuera de las estadísticas comerciales; pago y factura se conservan.`
              : "Sólo para compras de prueba del equipo autorizadas de antemano. Excluye el pedido de las ventas, lo deja archivado y puede reingresar las unidades al stock. Pago y factura no se modifican."}
          </p>
        </div>
        {!classified && (
          <AdminSecondaryButton
            className="shrink-0"
            disabled={busy}
            icon={<FlaskConical className="size-4" />}
            onClick={() => void openModal()}
          >
            Clasificar como prueba
          </AdminSecondaryButton>
        )}
      </div>
      <AdminModal
        open={open}
        title="Clasificar como compra de prueba"
        eyebrow="Super administrador"
        description="No se cancela el pago ni se emite nota de crédito. Queda registrado quién lo hizo y por qué."
        compact
        onClose={() => { if (!busy) setOpen(false) }}
        footer={
          <div className="flex justify-end gap-2">
            <AdminSecondaryButton onClick={() => setOpen(false)} disabled={busy}>Cancelar</AdminSecondaryButton>
            <AdminButton
              variant="primary"
              onClick={() => void submit()}
              disabled={busy || !ready}
              icon={busy ? <RefreshCw className="size-4 animate-spin" /> : undefined}
            >
              Clasificar como prueba
            </AdminButton>
          </div>
        }
      >
        {preview === null && busy && (
          <p className="text-sm text-[var(--admin-text-soft)]">Comprobando el pedido…</p>
        )}
        {preview && preview.reasons.length > 0 && (
          <div role="alert" className="text-sm" data-testid="order-test-blockers">
            <p className="font-bold text-[var(--admin-text)]">No se puede clasificar como prueba:</p>
            <ul className="mt-1 list-disc pl-5 text-[var(--admin-text-soft)]">
              {preview.reasons.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>
        )}
        {preview && preview.reasons.length === 0 && (
          <div className="flex flex-col gap-3 text-sm">
            <AdminTextarea
              title="Motivo"
              ariaLabel="Motivo de la clasificación"
              value={reason}
              onChange={setReason}
              maxLength={TEST_ORDER_REASON_MAX}
              placeholder="Ej.: compra de prueba del checkout hecha por el equipo; los productos siguen en el depósito."
            />
            {trimmedReason.length > 0 && trimmedReason.length < TEST_ORDER_REASON_MIN && (
              <p className="text-xs text-[var(--admin-text-soft)]">El motivo necesita al menos {TEST_ORDER_REASON_MIN} caracteres.</p>
            )}
            {pendingUnits > 0 ? (
              <div>
                <label className="flex items-start gap-2 text-[var(--admin-text)]">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={restock && !unsupported}
                    disabled={unsupported}
                    onChange={(event) => setRestock(event.target.checked)}
                  />
                  <span>Reingresar al stock {unitsLabel(pendingUnits)} (sólo si las tenés físicamente)</span>
                </label>
                <ul className="mt-1 list-disc pl-10 text-[var(--admin-text-soft)]" data-testid="order-test-restock-plan">
                  {preview.restockPlan.filter((item) => item.pending > 0).map((item) => (
                    <li key={item.orderItemId}>
                      {item.productName}{item.variantName ? ` · ${item.variantName}` : ""}: +{item.pending}
                    </li>
                  ))}
                </ul>
                {unsupported && (
                  <p className="mt-1 text-xs text-[var(--admin-text-soft)]">
                    Hay artículos que no se pueden reingresar automáticamente: corregí ese stock desde Productos.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[var(--admin-text-soft)]">No hay unidades pendientes de reingresar al stock.</p>
            )}
            <div>
              <p className="mb-1 font-bold text-[var(--admin-text)]">Escribí {expectedConfirmation} para confirmar</p>
              <AdminTextInput
                title={`Confirmación ${expectedConfirmation}`}
                value={confirmation}
                onChange={setConfirmation}
                maxLength={20}
                autoComplete="off"
                placeholder={expectedConfirmation}
              />
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-sm font-bold text-[var(--admin-text)]">{error}</p>}
      </AdminModal>
    </section>
  )
}
