"use client"

import { useMemo, useState } from "react"
import { Link2, RefreshCw } from "lucide-react"

import type { UnlinkedMercadoLibreGroup } from "@/lib/mercadolibre/product-matching"
import {
  saveMercadoLibreProductMapping,
  type MercadoLibreMappingCatalogProduct,
} from "@/lib/supabase/queries/mercadolibre-sales"
import { AdminSelect } from "../../components/admin-controls"

interface TargetOption {
  value: string
  label: string
  sku: string | null
  searchText: string
}

/** Un destino por producto sin variantes o por variante exacta: nunca el producto padre ambiguo. */
function buildTargetOptions(catalog: MercadoLibreMappingCatalogProduct[]): TargetOption[] {
  return [...catalog]
    .sort((left, right) => left.nombre.localeCompare(right.nombre, "es", { sensitivity: "base" }))
    .flatMap((product) => {
      const inactive = product.activo ? "" : " (inactivo)"
      if (!product.producto_variantes.length) {
        return [{
          value: `p:${product.id}`,
          label: `${product.nombre}${inactive}`,
          sku: product.sku,
          searchText: `${product.nombre} ${product.sku ?? ""}`,
        }]
      }
      return product.producto_variantes.map((variant) => ({
        value: `v:${product.id}:${variant.id}`,
        label: `${product.nombre} · ${variant.nombre}${inactive || (variant.activo ? "" : " (inactiva)")}`,
        sku: variant.sku,
        searchText: `${product.nombre} ${variant.nombre} ${variant.sku ?? ""}`,
      }))
    })
}

function parseTarget(value: string) {
  const [kind, productText, variantText] = value.split(":")
  const productId = Number(productText)
  if (!Number.isInteger(productId) || productId <= 0) return null
  if (kind === "p") return { productId, variantId: null }
  const variantId = Number(variantText)
  return kind === "v" && Number.isInteger(variantId) && variantId > 0 ? { productId, variantId } : null
}

/**
 * Resolución manual de líneas sin vincular antes de importar. Cada vínculo se
 * guarda como alias de SKU (o publicación + variante si no hay SKU) y queda
 * disponible para futuras importaciones.
 */
export function MercadoLibreUnlinkedResolver({
  groups,
  catalog,
  disabled,
  onSaved,
}: {
  groups: UnlinkedMercadoLibreGroup[]
  catalog: MercadoLibreMappingCatalogProduct[] | null
  disabled: boolean
  onSaved: () => Promise<void>
}) {
  const options = useMemo(() => buildTargetOptions(catalog ?? []), [catalog])
  const [selection, setSelection] = useState<Record<string, string>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState("")

  if (!groups.length) return null
  const unlinkedLines = groups.reduce((total, group) => total + group.lines, 0)

  const save = async (group: UnlinkedMercadoLibreGroup) => {
    const target = parseTarget(selection[group.key] ?? "")
    if (!target || !group.mappingType || savingKey) return
    setSavingKey(group.key)
    setError("")
    try {
      await saveMercadoLibreProductMapping({
        type: group.mappingType,
        sku: group.sku,
        listingId: group.listingId,
        variant: group.variant,
        ...target,
      })
      await onSaved()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "No se pudo guardar el vínculo.")
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <section aria-labelledby="ml-unlinked-title" className="rounded-xl border border-amber-300/22 bg-amber-300/6 px-3 py-2.5">
      <h4 id="ml-unlinked-title" className="text-xs font-black text-amber-100">
        Sin vincular: {unlinkedLines} {unlinkedLines === 1 ? "línea" : "líneas"}
      </h4>
      <p className="mt-0.5 text-11px leading-5 text-amber-100/70">
        No se vinculan por nombre. Elegí la variante exacta de BEYONIX: el vínculo se guarda y las próximas importaciones lo usan solas.
      </p>
      {error && <p role="alert" className="mt-2 rounded-lg border border-red-400/25 bg-red-400/10 px-2.5 py-1.5 text-11px text-red-100">{error}</p>}
      <ul className="mt-2 space-y-1.5">
        {groups.map((group) => {
          const saving = savingKey === group.key
          return (
            <li key={group.key} className="flex flex-col gap-2 rounded-lg border border-white/8 bg-black/25 px-2.5 py-2 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1 text-11px leading-5 text-white/60">
                <p className="font-black text-white">
                  {group.sku ? `SKU ML ${group.sku}` : "Sin SKU"}
                  <span className="ml-1.5 font-semibold text-white/40">· {group.lines} {group.lines === 1 ? "línea" : "líneas"}</span>
                </p>
                <p className="truncate" title={group.title}>{group.title}</p>
                <p className="text-white/40">
                  {group.variant ? `Variante: ${group.variant}` : "Sin variante"} · {group.listingId ? `Publicación ${group.listingId}` : "Sin publicación"}
                </p>
              </div>
              {group.mappingType ? (
                <div className="flex w-full shrink-0 gap-1.5 lg:w-auto">
                  <div className="min-w-0 flex-1 lg:w-[22.5rem] lg:flex-none">
                    <AdminSelect
                      title="Producto BEYONIX"
                      ariaLabel={`Producto BEYONIX para ${group.sku ?? group.title}`}
                      value={selection[group.key] ?? ""}
                      disabled={disabled || saving || !catalog}
                      searchable
                      searchPlaceholder="Buscar por nombre o SKU..."
                      onChange={(value) => setSelection((current) => ({ ...current, [group.key]: value }))}
                    >
                      <option value="">Elegir producto / variante</option>
                      {options.map((option) => (
                        <option key={option.value} value={option.value} data-search={option.searchText} data-meta={option.sku ?? undefined} data-selected-label={option.label}>
                          {option.label}
                        </option>
                      ))}
                    </AdminSelect>
                  </div>
                  <button
                    type="button"
                    onClick={() => void save(group)}
                    disabled={disabled || saving || !parseTarget(selection[group.key] ?? "")}
                    className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-beyonix-sky/28 bg-beyonix-blue/24 px-3 text-xs font-black text-beyonix-sky transition hover:border-beyonix-sky/55 hover:bg-beyonix-blue/42 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {saving ? <RefreshCw className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}
                    Vincular
                  </button>
                </div>
              ) : (
                <p className="text-11px text-amber-100/70 lg:w-96">Sin SKU ni variante: no hay una clave segura para vincularla desde acá.</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
