"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { Barcode, ListPlus, ScanLine, Search } from "lucide-react"

import { AdminButton, AdminSection, AdminTextInput } from "@/app/admin/components/admin-controls"
import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { MAX_CATALOG_SEARCH_LENGTH } from "@/lib/business/cost-catalog-search"
import { buildLabelTargets, type LabelCatalogProduct, type LabelTarget } from "@/lib/labels/catalog"
import { generateBeyonixVariantCode, loadLabelProducts, searchLabelCatalog } from "@/lib/labels/client"
import { removeFromQueue, setQueueCopies, type LabelQueueItem, type QueueAddResult } from "@/lib/labels/queue"

import { LabelQuantity } from "./label-quantity"
import { LabelSwatch } from "./label-swatch"

const SEARCH_DEBOUNCE_MS = 300

export type AddTargetHandler = (target: LabelTarget, code: string, copies: number) => QueueAddResult | null
export type QueueUpdate = (change: (queue: LabelQueueItem[]) => LabelQueueItem[]) => void

/** "NEGRO · AP01": color (o variante) y SKU, lo mismo que sale impreso en la línea 2. */
export function targetDetail(variantLabel: string | null, sku: string | null) {
  return [variantLabel, sku].filter(Boolean).join(" · ")
}

function findQueued(queue: readonly LabelQueueItem[], target: LabelTarget) {
  return queue.find((item) => !item.issue && item.productId === target.productId && item.variantId === target.variantId) ?? null
}

function TargetRow({ target, queued, maxCopies, onAdd, update, onGenerated }: {
  target: LabelTarget
  queued: LabelQueueItem | null
  maxCopies: number
  onAdd: AddTargetHandler
  update: QueueUpdate
  onGenerated: (productId: number) => Promise<void>
}) {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState("")
  const option = target.options[0]
  const detail = targetDetail(target.variantLabel, target.sku) || "Sin color ni SKU"
  const label = [target.productName, target.variantLabel].filter(Boolean).join(" ")

  async function generate() {
    if (!target.variantId || generating) return
    setGenerating(true)
    setError("")
    try {
      await generateBeyonixVariantCode(target.productId, target.variantId)
      await onGenerated(target.productId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo generar el código.")
    } finally {
      setGenerating(false)
    }
  }

  return (
    <li className="admin-label-row" data-selected={queued ? "true" : "false"}>
      <div className="flex min-h-11 items-center gap-3 px-3 py-1.5">
        <LabelSwatch colorHex={target.colorHex} colorHexSecondary={target.colorHexSecondary} />
        <p className="min-w-0 flex-1 truncate text-sm font-bold text-white" title={option ? `Código ${option.code}` : undefined}>
          {detail}
          {!target.active && <span className="ml-2 text-11px font-bold text-amber-300">Inactivo</span>}
        </p>
        {option ? (
          <LabelQuantity
            value={queued?.copies ?? 0}
            max={maxCopies}
            label={label}
            onChange={(copies) => (queued ? update((queue) => setQueueCopies(queue, queued.key, copies, maxCopies)) : onAdd(target, option.code, copies))}
            onRemove={() => queued && update((queue) => removeFromQueue(queue, queued.key))}
          />
        ) : target.variantId ? (
          <AdminButton size="sm" className="shrink-0" icon={<Barcode className="size-3.5" />} disabled={generating} onClick={() => void generate()}>
            {generating ? "Generando…" : "Generar código"}
          </AdminButton>
        ) : (
          <span className="shrink-0 text-xs font-bold text-white/55">Sin código</span>
        )}
      </div>
      {!option && !target.variantId && <p className="px-3 pb-2 pl-10 text-xs text-white/55">Cargá un código de barras o SKU en el producto para poder imprimirlo.</p>}
      {option?.classification.notice && <p className="px-3 pb-2 pl-10 text-xs text-amber-300">{option.classification.notice}</p>}
      {error && <p role="alert" className="px-3 pb-2 pl-10 text-xs font-bold text-red-300">{error}</p>}
    </li>
  )
}

function ProductResult({ product, queue, maxCopies, onAdd, update, onGenerated }: {
  product: LabelCatalogProduct
  queue: readonly LabelQueueItem[]
  maxCopies: number
  onAdd: AddTargetHandler
  update: QueueUpdate
  onGenerated: (productId: number) => Promise<void>
}) {
  const { targets } = buildLabelTargets(product)
  const missing = targets.filter((target) => target.options.length > 0 && !findQueued(queue, target))
  return (
    <li className="admin-label-product">
      <div className="flex items-center justify-between gap-2 px-3 pb-1 pt-2.5">
        <p className="min-w-0 truncate text-xs font-black uppercase tracking-wide text-white" title={product.name}>
          {product.name}
          {!product.active && <span className="ml-2 normal-case tracking-normal text-amber-300">Inactivo</span>}
        </p>
        {targets.length > 1 && missing.length > 0 && (
          <button type="button" className="admin-label-link shrink-0 text-xs font-bold" onClick={() => missing.forEach((target) => onAdd(target, target.options[0].code, 1))}>
            <ListPlus className="size-3.5" aria-hidden="true" />
            Agregar {missing.length === targets.length ? "todas" : "las que faltan"}
          </button>
        )}
      </div>
      <ul>
        {targets.map((target) => (
          <TargetRow
            key={`${target.variantId ?? 0}:${target.options.map((option) => option.code).join("|")}`}
            target={target}
            queued={findQueued(queue, target)}
            maxCopies={maxCopies}
            onAdd={onAdd}
            update={update}
            onGenerated={onGenerated}
          />
        ))}
      </ul>
    </li>
  )
}

export function LabelSearchPanel({ queue, maxCopies, onAdd, update, onProducts, className }: {
  queue: readonly LabelQueueItem[]
  maxCopies: number
  onAdd: AddTargetHandler
  update: QueueUpdate
  onProducts: (products: LabelCatalogProduct[]) => void
  className?: string
}) {
  const [query, setQuery] = useState("")
  const [offset, setOffset] = useState(0)
  const [results, setResults] = useState<LabelCatalogProduct[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [searchNonce, setSearchNonce] = useState(0)
  const pendingScan = useRef<string | null>(null)
  const reportProducts = useEffectEvent((products: LabelCatalogProduct[]) => onProducts(products))
  const addScanned = useEffectEvent((target: LabelTarget, code: string) => onAdd(target, code, 1))

  useEffect(() => {
    const controller = new AbortController()
    let current = true
    setLoading(true)
    setError("")
    const timer = window.setTimeout(async () => {
      try {
        const page = await searchLabelCatalog(query, offset, controller.signal)
        if (!current) return
        setResults((previous) => {
          if (offset === 0) return page.items
          const known = new Set(previous.map((item) => item.id))
          return [...previous, ...page.items.filter((item) => !known.has(item.id))]
        })
        setHasMore(page.hasMore)
        reportProducts(page.items)
        // Lector de códigos: Enter con un código exacto lo suma directo.
        const scanned = pendingScan.current
        if (scanned && scanned === query.trim()) {
          pendingScan.current = null
          const matches = page.items.flatMap((product) => buildLabelTargets(product).targets.flatMap((target) => {
            const option = target.options.find((candidate) => candidate.code.toUpperCase() === scanned.toUpperCase())
            return option ? [{ target, code: option.code }] : []
          }))
          if (matches.length === 1) {
            const outcome = addScanned(matches[0].target, matches[0].code)
            setQuery("")
            setNotice(outcome?.rejected ? "La tanda llegó al máximo de artículos." : `Escaneado: ${[matches[0].target.productName, matches[0].target.variantLabel].filter(Boolean).join(" · ")} +1.`)
          } else {
            setNotice(matches.length ? "El código coincide con más de un artículo: elegilo de la lista." : "No hay un artículo con ese código exacto.")
          }
        }
      } catch {
        if (!current) return
        setError("No se pudieron cargar los productos. Revisá la conexión y volvé a buscar.")
        if (offset === 0) { setResults([]); setHasMore(false) }
      } finally {
        if (current) setLoading(false)
      }
    }, offset === 0 && !pendingScan.current ? SEARCH_DEBOUNCE_MS : 0)
    return () => {
      current = false
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, offset, searchNonce])

  async function refreshProduct(productId: number) {
    const [product] = await loadLabelProducts([productId])
    if (!product) return
    setResults((previous) => previous.map((item) => (item.id === productId ? product : item)))
    onProducts([product])
  }

  return (
    <AdminSection compact icon={<Search className="size-4" />} title="Buscar productos" description="Por nombre, SKU o código de barras." className={className}>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          const value = query.trim()
          if (!value) return
          pendingScan.current = value
          setOffset(0)
          setNotice("")
          setSearchNonce((current) => current + 1)
        }}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <AdminTextInput
              title="Buscar"
              ariaLabel="Buscar productos"
              placeholder="Nombre, SKU o código de barras…"
              icon={<Search className="size-4" />}
              value={query}
              maxLength={MAX_CATALOG_SEARCH_LENGTH}
              onChange={(value) => { setQuery(value); setOffset(0); setNotice("") }}
            />
          </div>
          <AdminHelpTip label="Lector de códigos" text="Con un lector: escaneá y el lector envía Enter. Si el código es de un solo artículo, se suma 1 etiqueta y podés seguir escaneando." />
        </div>
        {notice && <p role="status" className="flex items-center gap-1.5 text-xs font-bold text-white/70"><ScanLine className="size-3.5" />{notice}</p>}
      </form>
      <div className="mt-3">
        {error && <p role="alert" className="text-sm font-bold text-red-300">{error}</p>}
        {!error && !loading && results.length === 0 && (
          <p className="py-8 text-center text-sm text-white/55">{query.trim() ? "Sin resultados para esa búsqueda." : "No hay productos cargados."}</p>
        )}
        {results.length > 0 && (
          <ul className="admin-label-results" aria-busy={loading}>
            {results.map((product) => (
              <ProductResult key={product.id} product={product} queue={queue} maxCopies={maxCopies} onAdd={onAdd} update={update} onGenerated={refreshProduct} />
            ))}
          </ul>
        )}
        {loading && <p className="py-3 text-center text-xs font-bold text-white/55">Buscando…</p>}
        {hasMore && !loading && (
          <div className="mt-3 flex justify-center">
            <AdminButton size="sm" onClick={() => setOffset(results.length)}>Ver más productos</AdminButton>
          </div>
        )}
      </div>
    </AdminSection>
  )
}
