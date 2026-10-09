"use client"

import { useEffect, useId, useState } from "react"
import { Loader2, Plus, Trash2 } from "lucide-react"

import type { BarcodeAlias } from "@/lib/barcodes/barcode-aliases"
import {
  COLOR_MODE_HELP,
  COLOR_MODE_LABELS,
  PRODUCT_COLOR_MODES,
  colorModeBlocker,
  type ProductColorMode,
} from "@/lib/products/color-mode"
import { RANDOM_SWATCH_STYLE } from "@/lib/products/variant-swatch"
import {
  addBarcodeAlias,
  listBarcodeAliases,
  removeBarcodeAlias,
  setProductoColorMode,
} from "@/lib/supabase/queries/producto-variantes"

import {
  AdminDangerButton,
  AdminInfoBlock,
  AdminSecondaryButton,
  AdminSelect,
  adminControlClassName,
} from "../../components/admin-controls"
import { AdminHelpTip } from "../../components/admin-help-tip"

const PRODUCT_SCOPE = "product"

interface ProductSalesOptionsProps {
  productId: number
  variants: ReadonlyArray<{ id: number; nombre: string; codigoBarra: string | null }>
  /** Código principal del producto (productos.codigo_barra), si tiene. */
  productBarcode?: string | null
  colorMode: ProductColorMode
  onColorModeChange: (value: ProductColorMode) => void
}

/** Alcance de un código vinculado: el producto comercial o una variante física. */
export function aliasScopeLabel(alias: Pick<BarcodeAlias, "variantId" | "variantName">) {
  return alias.variantId == null ? "Producto completo" : `Variante: ${alias.variantName ?? `#${alias.variantId}`}`
}

/**
 * Venta por color y códigos de barra del producto. Ambos se guardan al
 * instante (no esperan "Guardar cambios").
 */
export function ProductSalesOptions({
  productId,
  variants,
  productBarcode = null,
  colorMode,
  onColorModeChange,
}: ProductSalesOptionsProps) {
  const radioName = useId()
  const [savingMode, setSavingMode] = useState<ProductColorMode | null>(null)
  const [aliases, setAliases] = useState<BarcodeAlias[] | null>(null)
  const [newBarcode, setNewBarcode] = useState("")
  const [scope, setScope] = useState(PRODUCT_SCOPE)
  const [aliasBusy, setAliasBusy] = useState(false)
  const [error, setError] = useState("")
  const simple = colorMode === "aleatorio_simple"

  useEffect(() => {
    let active = true
    listBarcodeAliases(productId)
      .then((loaded) => {
        if (active) setAliases(loaded)
      })
      .catch((loadError: unknown) => {
        if (!active) return
        setAliases([])
        setError(loadError instanceof Error ? loadError.message : "No se pudieron cargar los códigos vinculados.")
      })
    return () => {
      active = false
    }
  }, [productId])

  const changeMode = async (mode: ProductColorMode) => {
    if (savingMode || mode === colorMode || colorModeBlocker(mode, variants.length)) return
    setSavingMode(mode)
    setError("")
    try {
      onColorModeChange((await setProductoColorMode(productId, mode)).colorMode)
      setAliases(await listBarcodeAliases(productId))
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : "No se pudo actualizar la venta por color.")
    } finally {
      setSavingMode(null)
    }
  }

  const addAlias = async () => {
    const barcode = newBarcode.trim()
    if (!barcode || aliasBusy) return
    setAliasBusy(true)
    setError("")
    try {
      const variantId = simple || scope === PRODUCT_SCOPE ? null : Number(scope)
      const alias = await addBarcodeAlias(productId, barcode, variantId)
      setAliases((current) => [...(current ?? []), alias])
      setNewBarcode("")
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : "No se pudo vincular el código.")
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
      setError(removeError instanceof Error ? removeError.message : "No se pudo quitar el código vinculado.")
    } finally {
      setAliasBusy(false)
    }
  }

  const principals = [
    ...(productBarcode?.trim() ? [{ key: "product", code: productBarcode.trim(), scope: "Producto completo" }] : []),
    ...variants.flatMap((variant) => variant.codigoBarra?.trim()
      ? [{ key: `variant-${variant.id}`, code: variant.codigoBarra.trim(), scope: simple ? "Artículo único (aleatorio)" : `Variante: ${variant.nombre}` }]
      : []),
  ]

  return (
    <section className="product-editor-sales-options space-y-3 border-t border-white/8 pt-2.5" aria-label="Opciones de venta">
      {error && (
        <AdminInfoBlock role="alert" tone="danger">
          {error}
        </AdminInfoBlock>
      )}

      <fieldset className="space-y-1.5" data-color-mode={colorMode}>
        <legend className="mb-1.5 flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-white">
          Venta por color
          <AdminHelpTip label="Venta por color" text="Color específico: el cliente elige. Aleatorio sin seguimiento: un único artículo con stock total y varios códigos. Aleatorio con variantes: el cliente no elige, pero cada color físico tiene su stock y su código." />
        </legend>
        {PRODUCT_COLOR_MODES.map((mode) => {
          const blocker = mode === colorMode ? null : colorModeBlocker(mode, variants.length)
          const checked = mode === colorMode
          return (
            <label
              key={mode}
              data-color-mode-option={mode}
              className={`admin-toggle flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${checked ? "admin-toggle-on" : ""} ${blocker ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <input
                type="radio"
                name={radioName}
                value={mode}
                checked={checked}
                disabled={Boolean(blocker) || savingMode !== null}
                onChange={() => void changeMode(mode)}
                className="mt-0.5 size-4 shrink-0 accent-blue-500"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-black text-white">
                  {mode !== "especifico" && <span aria-hidden="true" style={RANDOM_SWATCH_STYLE} className="inline-block size-3.5 shrink-0 rounded-full" />}
                  {COLOR_MODE_LABELS[mode]}
                  {savingMode === mode && <Loader2 className="size-3.5 animate-spin text-white" />}
                </span>
                <span className="mt-0.5 block text-xs font-semibold leading-4 text-white/60">{blocker ?? COLOR_MODE_HELP[mode]}</span>
              </span>
            </label>
          )
        })}
      </fieldset>

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-white">
          Códigos de barra
          <AdminHelpTip
            label="Códigos de barra"
            text="Todos estos códigos identifican el artículo en Productos, Compras, Despachos y Etiquetas. Un código vinculado al producto completo no se asocia a ningún color; vinculado a una variante, identifica esa variante física."
          />
        </p>

        <div>
          <p className="mb-1 text-10px font-black uppercase tracking-widest text-white/55">Código principal</p>
          {principals.length ? (
            <ul className="space-y-1" data-barcode-principal>
              {principals.map((principal) => (
                <li key={principal.key} className="flex min-w-0 items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-sm font-bold text-white">{principal.code}</span>
                  <span className="shrink-0 text-xs text-white/60">{principal.scope}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-white/60">Sin código principal: cargalo o generá el código BEYONIX en la variante.</p>
          )}
        </div>

        <div>
          <p className="mb-1 text-10px font-black uppercase tracking-widest text-white/55">Códigos vinculados</p>
          {aliases === null ? (
            <p className="text-xs text-white/60">Cargando…</p>
          ) : aliases.length ? (
            <ul className="space-y-1.5" data-barcode-linked>
              {aliases.map((alias) => (
                <li key={alias.barcode} className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-white/8 px-2.5 py-1.5">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-sm font-bold text-white">{alias.barcode}</span>
                    <span className="block truncate text-xs text-white/60">{aliasScopeLabel(alias)}</span>
                  </span>
                  <AdminDangerButton
                    size="icon"
                    title={`Quitar ${alias.barcode}`}
                    aria-label={`Quitar código vinculado ${alias.barcode}`}
                    disabled={aliasBusy}
                    onClick={() => void removeAlias(alias.barcode)}
                  >
                    <Trash2 className="size-3.5 text-white" />
                  </AdminDangerButton>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-white/60">Sin códigos vinculados.</p>
          )}
        </div>

        <div className={`grid min-w-0 gap-2 ${simple ? "sm:grid-cols-[minmax(0,1fr)_auto]" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]"}`}>
          <input
            type="text"
            value={newBarcode}
            maxLength={64}
            placeholder="Escaneá o escribí el código"
            aria-label="Nuevo código de barra vinculado"
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
          {!simple && (
            <AdminSelect title="Vincular a" ariaLabel="Vincular a" value={scope} onChange={setScope} disabled={aliasBusy}>
              <option value={PRODUCT_SCOPE}>Producto completo</option>
              {variants.map((variant) => (
                <option key={variant.id} value={String(variant.id)}>{`Variante: ${variant.nombre}`}</option>
              ))}
            </AdminSelect>
          )}
          <AdminSecondaryButton
            size="sm"
            onClick={() => void addAlias()}
            disabled={aliasBusy || !newBarcode.trim()}
            className="h-10"
          >
            {aliasBusy ? <Loader2 className="size-3.5 animate-spin text-white" /> : <Plus className="size-3.5 text-white" />}
            Vincular
          </AdminSecondaryButton>
        </div>
        {simple && <p className="text-xs text-white/55">En aleatorio sin seguimiento, cada código se vincula al producto completo.</p>}
      </div>
    </section>
  )
}
