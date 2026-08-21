"use client"

import { useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Minus, PackageSearch, Plus } from "lucide-react"

import type { SupabaseProductoVariante } from "@/lib/supabase/types"
import { adjustProductoVarianteStock } from "@/lib/supabase/queries/producto-variantes"
import {
  AdminBadge,
  AdminFormField,
  AdminModal,
  AdminPrimaryButton,
  AdminSecondaryButton,
  adminControlClassName,
} from "../../components/admin-controls"

const fieldInputClassName = `${adminControlClassName} !h-10 text-sm`

/**
 * Corrección manual de stock (recuento físico, unidades falladas), sin pasar
 * por el sistema de asignación de pool genérico. Compartido entre la fila
 * compacta de Productos y el editor completo, para no duplicar el modal.
 */
export function useStockAdjustment(
  productId: number | undefined,
  onAdjusted: (variant: SupabaseProductoVariante) => void,
) {
  const [target, setTarget] = useState<SupabaseProductoVariante | null>(null)
  const [quantity, setQuantity] = useState("")
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const keyRef = useRef<string | null>(null)

  const openStockAdjustment = (variant: SupabaseProductoVariante) => {
    setError("")
    setQuantity(String(variant.stock ?? 0))
    setReason("")
    keyRef.current = null
    setTarget(variant)
  }

  const close = () => {
    if (saving) return
    setTarget(null)
    setError("")
  }

  const stepQuantity = (delta: number) => {
    const current = Number(quantity) || 0
    setQuantity(String(Math.max(0, current + delta)))
  }

  const save = async () => {
    if (!target || !productId) return

    const newQuantity = Number(quantity)
    const trimmedReason = reason.trim()

    if (!Number.isInteger(newQuantity) || newQuantity < 0) {
      setError("La cantidad debe ser un número entero mayor o igual a 0.")
      return
    }
    if (!trimmedReason) {
      setError("Indicá el motivo del ajuste.")
      return
    }
    if (newQuantity === (target.stock ?? 0)) {
      setTarget(null)
      return
    }

    try {
      setSaving(true)
      setError("")
      if (!keyRef.current) {
        keyRef.current = `stock-adjustment:${crypto.randomUUID()}`
      }
      const updated = await adjustProductoVarianteStock(
        productId,
        target.id,
        { newQuantity, reason: trimmedReason },
        keyRef.current,
      )
      onAdjusted(updated)
      setTarget(null)
    } catch (adjustError) {
      setError(
        adjustError instanceof Error
          ? adjustError.message
          : "No se pudo ajustar el stock de la variante.",
      )
    } finally {
      setSaving(false)
    }
  }

  const currentStock = target?.stock ?? 0
  const parsedQuantity = Number(quantity)
  const delta = Number.isFinite(parsedQuantity) ? parsedQuantity - currentStock : 0

  const stockAdjustmentModal =
    target &&
    typeof document !== "undefined" &&
    createPortal(
      <div className="stock-adjustment-modal">
      <AdminModal
        open
        compact
        title="Ajustar stock"
        description="Corrección manual (recuento físico, unidades falladas). Queda registrada con el motivo indicado."
        onClose={close}
        footer={
          <div className="flex items-center justify-end gap-2.5 border-t border-white/8 pt-3">
            <AdminSecondaryButton size="sm" disabled={saving} onClick={close}>
              Cancelar
            </AdminSecondaryButton>
            <AdminPrimaryButton size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? "Guardando…" : "Confirmar ajuste"}
            </AdminPrimaryButton>
          </div>
        }
      >
        <div className="flex items-center gap-3 rounded-xl border border-beyonix-sky/20 bg-[linear-gradient(135deg,rgba(17,42,67,0.55),rgba(7,17,27,0.96))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full border-2"
            style={{
              backgroundColor: `${target.color_hex}26`,
              borderColor: `${target.color_hex}80`,
            }}
          >
            <span
              className="size-4 rounded-full border border-white/25"
              style={{ backgroundColor: target.color_hex }}
            />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-black text-white">
              {target.nombre}
            </span>
            <span className="mt-0.5 block text-10px font-bold uppercase tracking-wider text-white/45">
              {target.sku?.trim() || "Sin SKU"}
              {" · Stock actual "}
              <span className="text-beyonix-sky">{currentStock}</span>
            </span>
          </span>
        </div>

        <div className="mt-3 rounded-2xl border border-beyonix-sky/18 bg-[linear-gradient(160deg,rgba(9,23,36,0.94),rgba(4,12,20,0.98))] p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
          <div className="flex items-center justify-center gap-1.5 text-10px font-black uppercase tracking-widest text-white/48">
            <PackageSearch className="size-3.5 text-beyonix-sky/70" />
            Nueva cantidad
          </div>
          <div className="mt-2.5 flex items-center justify-center gap-3">
            <AdminSecondaryButton
              size="icon"
              aria-label="Restar una unidad"
              disabled={saving || parsedQuantity <= 0}
              onClick={() => stepQuantity(-1)}
              className="stock-adjustment-step-btn"
            >
              <Minus className="size-4" />
            </AdminSecondaryButton>
            <input
              value={quantity}
              inputMode="numeric"
              disabled={saving}
              onChange={(event) => setQuantity(event.target.value.replace(/\D/g, ""))}
              aria-label="Nueva cantidad"
              className={`${fieldInputClassName} !h-12 w-24 !text-center !text-2xl font-black tabular-nums`}
              placeholder="0"
            />
            <AdminSecondaryButton
              size="icon"
              aria-label="Sumar una unidad"
              disabled={saving}
              onClick={() => stepQuantity(1)}
              className="stock-adjustment-step-btn"
            >
              <Plus className="size-4" />
            </AdminSecondaryButton>
          </div>

          {delta !== 0 && (
            <div className="mt-2.5 flex justify-center">
              <AdminBadge tone={delta > 0 ? "success" : "danger"}>
                {delta > 0 ? `+${delta}` : delta} unidad{Math.abs(delta) === 1 ? "" : "es"}
              </AdminBadge>
            </div>
          )}
        </div>

        <div className="mt-3">
          <AdminFormField label="Motivo">
            <input
              value={reason}
              disabled={saving}
              onChange={(event) => setReason(event.target.value)}
              className={fieldInputClassName}
              placeholder="Por ej: unidades falladas, recuento físico"
              maxLength={300}
            />
          </AdminFormField>
        </div>

        {error && (
          <p className="mt-3 rounded-xl border border-red-400/20 bg-red-400/8 px-3 py-2 text-xs font-semibold text-red-200">
            {error}
          </p>
        )}
      </AdminModal>
      </div>,
      document.body,
    )

  return { openStockAdjustment, stockAdjustmentModal }
}
