"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { Barcode, Plus, ScanLine, Search } from "lucide-react"

import {
  AdminBadge,
  AdminButton,
  AdminPrimaryButton,
  AdminSection,
  AdminSelect,
  AdminTextInput,
} from "@/app/admin/components/admin-controls"
import { AdminHelpTip } from "@/app/admin/components/admin-help-tip"
import { MAX_CATALOG_SEARCH_LENGTH } from "@/lib/business/cost-catalog-search"
import {
  LABEL_CODE_SOURCE_LABELS,
  buildLabelTargets,
  type LabelCatalogProduct,
  type LabelTarget,
} from "@/lib/labels/catalog"
import { generateBeyonixVariantCode, loadLabelProducts, searchLabelCatalog } from "@/lib/labels/client"
import { parseCopies } from "@/lib/labels/queue"

import { LabelSwatch } from "./label-swatch"

const SEARCH_DEBOUNCE_MS = 300

export type AddTargetHandler = (target: LabelTarget, code: string, copies: number) => void

function TargetRow({ target, maxCopies, onAdd, onGenerated }: {
  target: LabelTarget
  maxCopies: number
  onAdd: AddTargetHandler
  onGenerated: (productId: number) => Promise<void>
}) {
  const [code, setCode] = useState(target.options[0]?.code ?? "")
  const [copies, setCopies] = useState("1")
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState("")
  const selected = target.options.find((option) => option.code === code) ?? target.options[0]
  const copyCount = parseCopies(copies, maxCopies)

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
    <li className="grid gap-2 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <LabelSwatch colorHex={target.colorHex} colorHexSecondary={target.colorHexSecondary} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-white">
            {target.variantLabel ?? "Artículo único"}
            {!target.active && <span className="ml-2 text-10px font-black uppercase tracking-widest text-amber-300">Inactivo</span>}
          </p>
          <p className="truncate text-xs text-white/55">{target.sku ? `SKU ${target.sku}` : "Sin SKU"}</p>
        </div>
      </div>
      {selected ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 pl-6.5">
          {target.options.length > 1 ? (
            <AdminSelect
              title="Código a imprimir"
              ariaLabel={`Código a imprimir de ${target.variantLabel ?? target.productName}`}
              value={selected.code}
              compact
              wrapperClassName="w-52 max-w-full"
              onChange={setCode}
            >
              {target.options.map((option) => (
                <option key={option.code} value={option.code}>{`${option.code} · ${LABEL_CODE_SOURCE_LABELS[option.source]}`}</option>
              ))}
            </AdminSelect>
          ) : (
            <span className="max-w-52 truncate font-mono text-xs font-bold text-white/80" title={selected.code}>{selected.code}</span>
          )}
          <AdminBadge tone={selected.classification.kind === "code128" ? "neutral" : "info"}>{selected.classification.label}</AdminBadge>
          <div className="w-16">
            <AdminTextInput
              title="Cantidad"
              placeholder="1"
              ariaLabel={`Cantidad de etiquetas de ${target.variantLabel ?? target.productName}`}
              inputMode="numeric"
              value={copies}
              className="h-9 px-2 text-center"
              onChange={(value) => setCopies(value.replace(/\D/g, "").slice(0, 3))}
            />
          </div>
          <AdminPrimaryButton
            size="sm"
            icon={<Plus className="size-3.5" />}
            disabled={!copyCount}
            aria-label={`Agregar ${target.variantLabel ?? target.productName} a la cola`}
            onClick={() => copyCount && onAdd(target, selected.code, copyCount)}
          >
            Agregar
          </AdminPrimaryButton>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 pl-6.5">
          <span className="text-xs font-bold text-white/55">Sin código</span>
          {target.variantId ? (
            <AdminButton size="sm" icon={<Barcode className="size-3.5" />} disabled={generating} onClick={() => void generate()}>
              {generating ? "Generando…" : "Generar código BEYONIX"}
            </AdminButton>
          ) : (
            <span className="text-xs text-white/45">Cargá un código o SKU en el producto.</span>
          )}
        </div>
      )}
      {selected?.classification.notice && <p className="text-xs text-amber-300 pl-6.5">{selected.classification.notice}</p>}
      {error && <p role="alert" className="text-xs font-bold text-red-300 pl-6.5">{error}</p>}
    </li>
  )
}

function ProductResult({ product, maxCopies, onAdd, onGenerated }: {
  product: LabelCatalogProduct
  maxCopies: number
  onAdd: AddTargetHandler
  onGenerated: (productId: number) => Promise<void>
}) {
  const { targets, groupAliases } = buildLabelTargets(product)
  const printable = targets.filter((target) => target.options.length > 0)
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-black leading-5 text-white">{product.name}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {product.randomSale && <AdminBadge tone="info">Venta aleatoria</AdminBadge>}
            {!product.active && <AdminBadge tone="warning">Inactivo</AdminBadge>}
            {product.variants.length > 0 && <AdminBadge>{product.variants.length} {product.variants.length === 1 ? "variante" : "variantes"}</AdminBadge>}
          </div>
        </div>
        {printable.length > 1 && (
          <AdminButton size="sm" onClick={() => printable.forEach((target) => onAdd(target, target.options[0].code, 1))}>
            Agregar todas ×1
          </AdminButton>
        )}
      </div>
      {product.randomSale && (
        <p className="mt-1.5 text-xs text-white/55">Cada variante física lleva su propio código: así se sabe qué color se entregó.</p>
      )}
      {groupAliases.length > 0 && (
        <p className="mt-1.5 text-xs text-white/55">
          Código de grupo {groupAliases.join(", ")}: no identifica el color, no se imprime.
        </p>
      )}
      <ul className="mt-1 divide-y divide-white/8">
        {targets.map((target) => (
          <TargetRow key={`${target.variantId ?? 0}:${target.options.map((option) => option.code).join("|")}`} target={target} maxCopies={maxCopies} onAdd={onAdd} onGenerated={onGenerated} />
        ))}
      </ul>
    </li>
  )
}

export function LabelSearchPanel({ maxCopies, onAdd, onProducts, className }: {
  maxCopies: number
  onAdd: AddTargetHandler
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
        // Lector de códigos: Enter con un código exacto lo agrega directo.
        const scanned = pendingScan.current
        if (scanned && scanned === query.trim()) {
          pendingScan.current = null
          const matches = page.items.flatMap((product) => buildLabelTargets(product).targets.flatMap((target) => {
            const option = target.options.find((candidate) => candidate.code.toUpperCase() === scanned.toUpperCase())
            return option ? [{ target, code: option.code }] : []
          }))
          if (matches.length === 1) {
            addScanned(matches[0].target, matches[0].code)
            setQuery("")
            setNotice(`Escaneado: ${matches[0].code} agregado ×1.`)
          } else {
            setNotice(matches.length ? "El código coincide con más de un artículo: elegilo de la lista." : "No hay un artículo con ese código exacto.")
          }
        }
      } catch {
        if (!current) return
        setError("No se pudieron cargar los artículos.")
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
    <AdminSection
      compact
      icon={<Search className="size-4" />}
      title="Buscar productos y variantes"
      description="Nombre, SKU, código de barra, código equivalente o color."
      className={className}
    >
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
              ariaLabel="Buscar productos y variantes"
              placeholder="Buscar o escanear un código…"
              icon={<Search className="size-4" />}
              value={query}
              maxLength={MAX_CATALOG_SEARCH_LENGTH}
              onChange={(value) => { setQuery(value); setOffset(0); setNotice("") }}
            />
          </div>
          <AdminHelpTip label="Escanear" text="Con un lector de códigos: escaneá y el lector envía Enter. Si el código identifica un solo artículo, se agrega ×1 a la cola y podés seguir escaneando." />
        </div>
        {notice && <p role="status" className="flex items-center gap-1.5 text-xs font-bold text-white/70"><ScanLine className="size-3.5" />{notice}</p>}
      </form>
      <div className="mt-3">
        {error && <p role="alert" className="text-sm font-bold text-red-300">{error}</p>}
        {!error && !loading && results.length === 0 && (
          <p className="py-6 text-center text-sm text-white/55">{query.trim() ? "Sin resultados." : "No hay productos cargados."}</p>
        )}
        <ul className="divide-y divide-white/10">
          {results.map((product) => (
            <ProductResult key={product.id} product={product} maxCopies={maxCopies} onAdd={onAdd} onGenerated={refreshProduct} />
          ))}
        </ul>
        {loading && <p className="py-3 text-center text-xs font-bold text-white/55">Buscando…</p>}
        {hasMore && !loading && (
          <div className="mt-3 flex justify-center">
            <AdminButton size="sm" onClick={() => setOffset(results.length)}>Ver más</AdminButton>
          </div>
        )}
      </div>
    </AdminSection>
  )
}
