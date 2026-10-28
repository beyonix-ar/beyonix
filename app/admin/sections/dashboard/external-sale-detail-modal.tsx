"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"

import {
  EXTERNAL_SALE_CHANNEL_LABELS,
  EXTERNAL_SALE_ORIGIN_LABELS,
  EXTERNAL_SALE_PAYMENT_LABELS,
  EXTERNAL_SALE_RETURN_CONDITION_LABELS,
  EXTERNAL_SALE_REVERSAL_LABELS,
  EXTERNAL_SALE_STATUS_LABELS,
  EXTERNAL_SALE_STOCK_EFFECT_LABELS,
  EXTERNAL_SALE_UNLINKED_SKU_WARNING,
  externalSaleCode,
  type ExternalSaleReturnCondition,
} from "@/lib/business/external-sales"
import {
  cancelExternalSale,
  getExternalSaleDetail,
  type ExternalSaleDetail,
  type ExternalSaleListItem,
} from "@/lib/supabase/queries/external-sales"
import { formatPrice } from "../productos/helpers"
import {
  AdminBadge,
  AdminDangerButton,
  AdminInfoBlock,
  AdminModal,
  AdminSecondaryButton,
  AdminTextarea,
} from "../../components/admin-controls"

const FIELD_LABELS: Record<string, string> = {
  sale_date: "Fecha", customer_name: "Cliente", channel: "Canal", sku: "SKU", product_name: "Producto",
  quantity: "Cantidad", shipping_amount: "Envío", payment_method_code: "Medio de pago", status: "Estado",
  gross_amount: "Precio final", declared_profit: "Ganancia declarada", notes: "Observación",
}

const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "—"

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/8 bg-black/20 px-3 py-2">
      <p className="text-10px font-black uppercase tracking-widest text-white/40">{label}</p>
      <div className="mt-0.5 wrap-break-word text-sm text-white">{children}</div>
    </div>
  )
}

type CancelKind = "entry_error" | "return"

export function ExternalSaleDetailModal({
  saleId,
  onClose,
  onEdit,
  onChanged,
}: {
  saleId: string
  onClose: () => void
  onEdit: (sale: ExternalSaleListItem) => void
  onChanged: (message: string) => void
}) {
  const [detail, setDetail] = useState<ExternalSaleDetail | null>(null)
  const [loadError, setLoadError] = useState("")
  const [cancelling, setCancelling] = useState(false)
  const [kind, setKind] = useState<CancelKind | null>(null)
  const [condition, setCondition] = useState<ExternalSaleReturnCondition | null>(null)
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const submittingRef = useRef(false)
  const cancelKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    setLoadError("")
    try {
      setDetail(await getExternalSaleDetail(saleId))
    } catch (detailError) {
      setLoadError(detailError instanceof Error ? detailError.message : "No se pudo cargar la venta.")
    }
  }, [saleId])

  useEffect(() => {
    void load()
  }, [load])

  const sale = detail?.sale
  const consumes = sale?.stock_effect === "consume" && sale.product_id != null
  const stockOutcome = !kind
    ? null
    : !consumes
      ? "No se modifica el stock: la venta no descontaba stock (histórica o sin producto vinculado)."
      : kind === "entry_error" || condition === "sellable"
        ? `Se devuelven ${sale?.quantity} unidades al stock vendible.`
        : condition === "damaged"
          ? "El producto no vuelve al stock vendible."
          : null

  const submit = async () => {
    if (!sale || !kind || submittingRef.current) return
    if (kind === "return" && !condition) {
      setError("Indicá si el producto volvió en condición vendible.")
      return
    }
    if (reason.trim().length < 10) {
      setError("El motivo debe tener al menos 10 caracteres.")
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    setError("")
    cancelKey.current ??= `external-sale-cancel:${crypto.randomUUID()}`
    try {
      await cancelExternalSale(sale.id, {
        kind,
        returnCondition: kind === "return" ? condition : null,
        reason: reason.trim(),
        idempotencyKey: cancelKey.current,
        version: sale.version,
      })
      cancelKey.current = null
      onChanged(kind === "entry_error" ? "Venta anulada por error de carga." : "Devolución registrada.")
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "No se pudo anular la venta.")
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const reversed = sale?.status === "reversed"

  return (
    <AdminModal
      open
      wide
      eyebrow={sale ? externalSaleCode(sale.sale_number) : "Venta externa"}
      title={sale?.product_name ?? "Detalle de venta"}
      onClose={() => { if (!submittingRef.current) onClose() }}
      footer={sale && !reversed ? (
        <div className="flex flex-wrap justify-end gap-2">
          {cancelling ? (
            <>
              <AdminSecondaryButton disabled={submitting} onClick={() => { setCancelling(false); setError("") }}>Volver</AdminSecondaryButton>
              <AdminDangerButton disabled={submitting || !kind || reason.trim().length < 10 || (kind === "return" && !condition)} onClick={() => void submit()}>
                {submitting ? "Registrando…" : kind === "return" ? "Registrar devolución" : "Anular venta"}
              </AdminDangerButton>
            </>
          ) : (
            <>
              <AdminSecondaryButton onClick={() => onEdit(sale)}>Editar</AdminSecondaryButton>
              <AdminDangerButton onClick={() => setCancelling(true)}>Registrar devolución / Anular venta</AdminDangerButton>
            </>
          )}
        </div>
      ) : undefined}
    >
      {loadError && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-red-200">{loadError}</p>
          <AdminSecondaryButton onClick={() => void load()}><RefreshCw className="size-4" /> Reintentar</AdminSecondaryButton>
        </div>
      )}
      {!sale && !loadError && <p className="text-sm text-white/55">Cargando venta…</p>}
      {sale && detail && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <AdminBadge tone={reversed ? "danger" : sale.status === "delivered" ? "success" : "info"}>{EXTERNAL_SALE_STATUS_LABELS[sale.status]}</AdminBadge>
            <AdminBadge tone={sale.stock_effect === "consume" ? "warning" : "neutral"}>
              {EXTERNAL_SALE_STOCK_EFFECT_LABELS[sale.stock_effect]} · {consumes ? (reversed ? "stock según anulación" : "descuenta stock") : "no mueve stock"}
            </AdminBadge>
            <AdminBadge tone="neutral">{EXTERNAL_SALE_ORIGIN_LABELS[sale.origin]}</AdminBadge>
          </div>

          {cancelling && !reversed && (
            <div className="space-y-3 rounded-2xl border border-red-300/20 bg-red-400/5 p-4">
              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">¿Qué pasó?</legend>
                {([
                  ["entry_error", "Venta cargada por error", "La venta nunca ocurrió."],
                  ["return", "Devolución real", "La venta ocurrió y el cliente devolvió el producto."],
                ] as const).map(([value, label, help]) => (
                  <label key={value} className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white/72 has-checked:border-red-300/50">
                    <input type="radio" name="external-sale-cancel-kind" checked={kind === value} onChange={() => { setKind(value); setCondition(null) }} className="mt-1" />
                    <span><span className="block font-black text-white">{label}</span>{help}</span>
                  </label>
                ))}
              </fieldset>
              {kind === "return" && (
                <fieldset className="grid gap-2 sm:grid-cols-2">
                  <legend className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">¿El producto volvió en condición vendible?</legend>
                  {(["sellable", "damaged"] as const).map((value) => (
                    <label key={value} className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-white has-checked:border-red-300/50">
                      <input type="radio" name="external-sale-return-condition" checked={condition === value} onChange={() => setCondition(value)} />
                      {value === "sellable" ? "Sí, vuelve a la venta" : "No, está dañado / no vendible"}
                    </label>
                  ))}
                </fieldset>
              )}
              {stockOutcome && <AdminInfoBlock tone="info">{stockOutcome} La venta no se borra: queda en el historial como anulada.</AdminInfoBlock>}
              <AdminTextarea title="Motivo" placeholder="Motivo obligatorio (mínimo 10 caracteres)" value={reason} maxLength={500} rows={2} className="min-h-16" onChange={setReason} />
              {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
              <p className="text-xs text-white/50">No reintegra dinero al cliente: eso se gestiona por fuera.</p>
            </div>
          )}

          {reversed && (
            <AdminInfoBlock tone="warning">
              <strong>{sale.reversal_kind ? EXTERNAL_SALE_REVERSAL_LABELS[sale.reversal_kind] : "Anulada"}</strong>
              {sale.return_condition ? ` · ${EXTERNAL_SALE_RETURN_CONDITION_LABELS[sale.return_condition]}` : ""}
              {` · ${dateTime(sale.reversed_at)} · ${sale.reversed_by_name ?? "Responsable no informado"}`}
              <span className="mt-1 block">{sale.reversal_reason}</span>
            </AdminInfoBlock>
          )}

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Item label="Fecha de venta">{sale.sale_date.split("-").reverse().join("/")}</Item>
            <Item label="Cliente">{sale.customer_name ?? "—"}</Item>
            <Item label="Canal">{sale.channel ? EXTERNAL_SALE_CHANNEL_LABELS[sale.channel] : "—"}{sale.channel_label && sale.channel_label !== (sale.channel ? EXTERNAL_SALE_CHANNEL_LABELS[sale.channel] : "") ? ` (“${sale.channel_label}”)` : ""}</Item>
            <Item label="Medio de pago">{sale.payment_method_code ? EXTERNAL_SALE_PAYMENT_LABELS[sale.payment_method_code] : "—"}{sale.payment_method && sale.payment_method !== (sale.payment_method_code ? EXTERNAL_SALE_PAYMENT_LABELS[sale.payment_method_code] : "") ? ` (“${sale.payment_method}”)` : ""}</Item>
            <Item label="SKU">{sale.sku ?? "—"}</Item>
            <Item label="Cantidad">{sale.quantity}</Item>
            <Item label="Precio final">{formatPrice(Number(sale.gross_amount))}</Item>
            <Item label="Envío (costo BEYONIX)">{formatPrice(Number(sale.shipping_amount))}</Item>
            <Item label="Ganancia">
              {sale.profit_amount == null ? "Sin costo conocido" : formatPrice(sale.profit_amount)}
              <span className="block text-10px text-white/45">{sale.profit_source === "declared" ? "Declarada" : sale.profit_source === "calculated" ? "Calculada con el costo histórico" : ""}</span>
            </Item>
            <Item label="Ganancia declarada">{sale.declared_profit == null ? "—" : formatPrice(Number(sale.declared_profit))}</Item>
            <Item label="Costo de mercadería">{sale.cost_amount == null ? "Costo no determinable" : formatPrice(sale.cost_amount)}</Item>
            <Item label="Producto vinculado">
              {detail.catalog.product
                ? `${detail.catalog.product.nombre}${detail.catalog.variant ? ` · ${detail.catalog.variant.nombre}` : ""}${detail.catalog.product.activo && (detail.catalog.variant?.activo ?? true) ? "" : " (archivado)"}`
                : sale.stock_effect === "none" ? EXTERNAL_SALE_UNLINKED_SKU_WARNING : "Sin producto vinculado"}
            </Item>
            <Item label="Registrada">{dateTime(sale.created_at)} · {sale.created_by_name ?? "—"}</Item>
            {sale.notes && <div className="sm:col-span-2 lg:col-span-4"><Item label="Observación">{sale.notes}</Item></div>}
          </div>

          {sale.cost_status === "inconsistent" && (
            <AdminInfoBlock tone="warning">
              Inconsistencia financiera: la ganancia declarada supera el ingreso neto de la venta. Se conserva la ganancia declarada; el costo no es determinable y no se suma al costo de ventas.
            </AdminInfoBlock>
          )}

          {detail.batch && (
            <AdminInfoBlock tone="neutral">
              Importada en la tanda del {dateTime(detail.batch.created_at)} ({detail.batch.source === "file" ? detail.batch.file_name : "filas pegadas"}, fila {sale.source_row_number}) · {detail.batch.rows_imported} ventas · {detail.batch.status === "reverted" ? "tanda deshecha" : EXTERNAL_SALE_STOCK_EFFECT_LABELS[detail.batch.stock_mode]}
              {sale.modified_after_import_at ? " · modificada después de importar" : ""}
            </AdminInfoBlock>
          )}

          {sale.source_values && (
            <details className="rounded-xl border border-white/8 bg-black/20 p-3 text-xs text-white/72">
              <summary className="cursor-pointer font-black text-white">Valores importados</summary>
              <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {Object.entries(sale.source_values).map(([header, value]) => (
                  <div key={header} className="flex justify-between gap-3 border-b border-white/5 py-1">
                    <dt className="text-white/45">{header}</dt>
                    <dd className="text-right">{value || "—"}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          <div>
            <p className="mb-2 text-11px font-black uppercase tracking-widest text-white/48">Historial</p>
            {detail.history.length === 0 ? (
              <p className="text-xs text-white/50">{detail.batch ? "Sin cambios desde la importación." : "Sin cambios registrados."}</p>
            ) : (
              <ol className="space-y-2 text-xs text-white/72">
                {detail.history.map((entry) => (
                  <li key={entry.id} className="rounded-xl border border-white/8 bg-black/20 px-3 py-2">
                    <p className="font-black text-white">{entry.label} · {dateTime(entry.created_at)} · {entry.actor_name ?? "—"}</p>
                    {entry.reason && <p className="mt-0.5">Motivo: {entry.reason}</p>}
                    {entry.changes.map((change) => (
                      <p key={change.field}>{FIELD_LABELS[change.field] ?? change.field}: {String(change.before ?? "—")} → {String(change.after ?? "—")}</p>
                    ))}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </AdminModal>
  )
}
