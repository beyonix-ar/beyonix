"use client"

import { useEffect, useState } from "react"
import { Loader2, Plus, Trash2 } from "lucide-react"

import type { BarcodeAlias } from "@/lib/barcodes/barcode-aliases"
import {
  addBarcodeAlias,
  listBarcodeAliases,
  removeBarcodeAlias,
  setProductoVentaAleatoria,
} from "@/lib/supabase/queries/producto-variantes"

import {
  AdminDangerButton,
  AdminInfoBlock,
  AdminSecondaryButton,
  AdminSelect,
  adminControlClassName,
} from "../../components/admin-controls"
import { AdminHelpTip } from "../../components/admin-help-tip"

const GROUP_VALUE = "group"

interface ProductSalesOptionsProps {
  productId: number
  variants: ReadonlyArray<{ id: number; nombre: string }>
  ventaAleatoria: boolean
  onVentaAleatoriaChange: (value: boolean) => void
}

/**
 * Venta con color/modelo aleatorio y códigos de barra equivalentes. Ambos se
 * guardan al instante (no esperan "Guardar cambios"): el stock y las reservas
 * siguen siendo por variante física.
 */
export function ProductSalesOptions({
  productId,
  variants,
  ventaAleatoria,
  onVentaAleatoriaChange,
}: ProductSalesOptionsProps) {
  const [savingRandom, setSavingRandom] = useState(false)
  const [aliases, setAliases] = useState<BarcodeAlias[] | null>(null)
  const [newBarcode, setNewBarcode] = useState("")
  const [target, setTarget] = useState(GROUP_VALUE)
  const [aliasBusy, setAliasBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    listBarcodeAliases(productId)
      .then((loaded) => {
        if (active) setAliases(loaded)
      })
      .catch((loadError: unknown) => {
        if (!active) return
        setAliases([])
        setError(loadError instanceof Error ? loadError.message : "No se pudieron cargar los códigos equivalentes.")
      })
    return () => {
      active = false
    }
  }, [productId])

  const canUseRandom = variants.length >= 2

  const toggleRandom = async () => {
    if (savingRandom || (!ventaAleatoria && !canUseRandom)) return
    setSavingRandom(true)
    setError("")
    try {
      onVentaAleatoriaChange(await setProductoVentaAleatoria(productId, !ventaAleatoria))
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "No se pudo actualizar la venta aleatoria.")
    } finally {
      setSavingRandom(false)
    }
  }

  const addAlias = async () => {
    const barcode = newBarcode.trim()
    if (!barcode || aliasBusy) return
    setAliasBusy(true)
    setError("")
    try {
      const alias = await addBarcodeAlias(productId, barcode, target === GROUP_VALUE ? null : Number(target))
      setAliases((current) => [...(current ?? []), alias])
      setNewBarcode("")
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "No se pudo guardar el código equivalente.")
    } finally {
      setAliasBusy(false)
    }
  }

  const removeAlias = async (barcode: string) => {
    if (aliasBusy) return
    setAliasBusy(true)
    setError("")
    try {
      await removeBarcodeAlias(productId, barcode)
      setAliases((current) => (current ?? []).filter((alias) => alias.barcode !== barcode))
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "No se pudo quitar el código equivalente.")
    } finally {
      setAliasBusy(false)
    }
  }

  return (
    <section className="product-editor-sales-options space-y-2.5 border-t border-white/8 pt-2.5" aria-label="Opciones de venta">
      {error && (
        <AdminInfoBlock role="alert" tone="danger">
          {error}
        </AdminInfoBlock>
      )}

      <button
        type="button"
        role="switch"
        aria-checked={ventaAleatoria}
        disabled={savingRandom || (!ventaAleatoria && !canUseRandom)}
        onClick={() => void toggleRandom()}
        className={`admin-toggle flex w-full cursor-pointer items-center justify-between gap-4 rounded-xl border px-4 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60 ${
          ventaAleatoria ? "admin-toggle-on" : ""
        }`}
      >
        <span>
          <span className="block text-sm font-black text-white">Venta con color/modelo aleatorio</span>
          <span className="mt-0.5 block text-xs font-semibold leading-4 text-white/60">
            {canUseRandom || ventaAleatoria
              ? "El cliente no elige color: se asigna una variante con stock y el armado acepta cualquiera del grupo."
              : "Necesita al menos dos variantes."}
          </span>
        </span>
        {savingRandom ? (
          <Loader2 className="size-5 shrink-0 animate-spin text-white" />
        ) : (
          <span className="admin-toggle-track relative h-6 w-11 shrink-0 rounded-full border transition">
            <span
              className={`admin-toggle-knob absolute top-0.5 size-4.5 rounded-full transition ${
                ventaAleatoria ? "left-5.5" : "left-0.5"
              }`}
            />
          </span>
        )}
      </button>

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-black text-white">
          Códigos de barra equivalentes
          <AdminHelpTip
            label="Códigos de barra equivalentes"
            text="Otros códigos que identifican este artículo (p. ej. el EAN del fabricante). Con variante, identifican esa variante; con «Todo el grupo», Compras pide elegir la variante física."
          />
        </p>

        {aliases === null ? (
          <p className="text-xs text-white/60">Cargando…</p>
        ) : aliases.length ? (
          <ul className="space-y-1.5">
            {aliases.map((alias) => (
              <li key={alias.barcode} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-white/8 px-2.5 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-sm font-bold text-white">{alias.barcode}</span>
                  <span className="block truncate text-xs text-white/60">
                    {alias.variantId == null ? "Todo el grupo" : alias.variantName ?? `Variante #${alias.variantId}`}
                  </span>
                </span>
                <AdminDangerButton
                  size="icon"
                  title={`Quitar ${alias.barcode}`}
                  aria-label={`Quitar código equivalente ${alias.barcode}`}
                  disabled={aliasBusy}
                  onClick={() => void removeAlias(alias.barcode)}
                >
                  <Trash2 className="size-3.5 text-white" />
                </AdminDangerButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-white/60">Sin códigos equivalentes.</p>
        )}

        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]">
          <input
            type="text"
            value={newBarcode}
            maxLength={64}
            placeholder="Escaneá o escribí el código"
            aria-label="Nuevo código de barra equivalente"
            disabled={aliasBusy}
            onChange={(event) => setNewBarcode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void addAlias()
              }
            }}
            className={`${adminControlClassName} !h-10 !text-sm`}
          />
          <AdminSelect title="Identifica a" value={target} onChange={setTarget} disabled={aliasBusy}>
            <option value={GROUP_VALUE}>Todo el grupo</option>
            {variants.map((variant) => (
              <option key={variant.id} value={String(variant.id)}>{variant.nombre}</option>
            ))}
          </AdminSelect>
          <AdminSecondaryButton
            size="sm"
            onClick={() => void addAlias()}
            disabled={aliasBusy || !newBarcode.trim()}
            className="h-10"
          >
            {aliasBusy ? <Loader2 className="size-3.5 animate-spin text-white" /> : <Plus className="size-3.5 text-white" />}
            Agregar
          </AdminSecondaryButton>
        </div>
      </div>
    </section>
  )
}
