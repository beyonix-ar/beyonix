"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { Barcode, Camera, CheckCircle2, Info, LoaderCircle, PackageSearch, Plus, ScanLine, Search } from "lucide-react"

import {
  AdminBadge,
  AdminButton,
  AdminGhostButton,
  AdminPrimaryButton,
  AdminSelect,
  AdminTextInput,
} from "@/app/admin/components/admin-controls"
import { CameraScanner } from "@/app/admin/sections/despachos/camera-scanner"
import { normalizeScannedCode } from "@/lib/admin/dispatch-scan"
import { MAX_CATALOG_SEARCH_LENGTH } from "@/lib/business/cost-catalog-search"
import {
  LABEL_CODE_SOURCE_LABELS,
  buildLabelTargets,
  type LabelCatalogProduct,
  type LabelTarget,
} from "@/lib/labels/catalog"
import { generateBeyonixVariantCode, loadLabelProducts, searchLabelCatalog } from "@/lib/labels/client"
import { queueItemKey } from "@/lib/labels/queue"
import { cn } from "@/lib/utils"

import { LabelSwatch } from "./label-swatch"
import { LABEL_STEP_IDS, LabelStepSection, QuantityStepper, plural } from "./label-ui"

const SEARCH_DEBOUNCE_MS = 300

export type AddTargetHandler = (target: LabelTarget, code: string, copies: number) => void

function Meta({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1">
      <span className="text-10px font-black uppercase text-white/45">{label}</span>
      <span className={cn("truncate font-bold text-white/85", mono && "font-mono")}>{children}</span>
    </span>
  )
}

function TargetRow({ target, maxCopies, queuedCopies, onAdd, onGenerated }: {
  target: LabelTarget
  maxCopies: number
  queuedCopies: ReadonlyMap<string, number>
  onAdd: AddTargetHandler
  onGenerated: (productId: number) => Promise<void>
}) {
  const [code, setCode] = useState(target.options[0]?.code ?? "")
  const [copies, setCopies] = useState(1)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState("")
  const selected = target.options.find((option) => option.code === code) ?? target.options[0]
  const name = target.variantLabel ?? target.productName
  const inQueue = selected ? queuedCopies.get(queueItemKey(target.productId, target.variantId, selected.code)) ?? 0 : 0

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
    <li className={cn("py-3 first:pt-0 last:pb-0", !target.active && "opacity-80")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="flex min-w-48 flex-1 items-start gap-2.5">
          <span className="mt-0.5 flex"><LabelSwatch colorHex={target.colorHex} colorHexSecondary={target.colorHexSecondary} /></span>
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-black text-white">
              <span className="min-w-0 truncate">{target.variantLabel ?? "Artículo único"}</span>
              {!target.active && <AdminBadge tone="warning" className="px-1.5 py-0.5">Inactiva</AdminBadge>}
              {inQueue > 0 && (
                <span className="inline-flex items-center gap-1 text-11px font-black text-emerald-300">
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />En cola ×{inQueue}
                </span>
              )}
            </p>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <Meta label="SKU">{target.sku ?? "—"}</Meta>
              {selected && target.options.length === 1 && <Meta label="Código" mono>{selected.code}</Meta>}
              {selected && (
                <span className="inline-flex items-center gap-1.5">
                  <AdminBadge tone={selected.classification.kind === "code128" ? "neutral" : "info"} className="px-1.5 py-0.5">{selected.classification.label}</AdminBadge>
                  <span className="text-11px text-white/50">{LABEL_CODE_SOURCE_LABELS[selected.source]}</span>
                </span>
              )}
            </div>
          </div>
        </div>
        {selected ? (
          <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:justify-end">
            {target.options.length > 1 && (
              <AdminSelect
                title="Código a imprimir"
                ariaLabel={`Código a imprimir de ${name}`}
                value={selected.code}
                compact
                wrapperClassName="w-48 max-w-full"
                onChange={setCode}
              >
                {target.options.map((option) => (
                  <option key={option.code} value={option.code}>{`${option.code} · ${LABEL_CODE_SOURCE_LABELS[option.source]}`}</option>
                ))}
              </AdminSelect>
            )}
            <QuantityStepper value={copies} max={maxCopies} name={name} size="sm" onChange={setCopies} />
            <AdminPrimaryButton
              size="sm"
              icon={<Plus className="size-3.5" />}
              aria-label={`Agregar ${name} a la cola`}
              onClick={() => { onAdd(target, selected.code, copies); setCopies(1) }}
            >
              Agregar
            </AdminPrimaryButton>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-amber-300">Sin código imprimible</span>
            {target.variantId ? (
              <AdminButton size="sm" icon={<Barcode className="size-3.5" />} disabled={generating} onClick={() => void generate()}>
                {generating ? "Generando…" : "Generar código BEYONIX"}
              </AdminButton>
            ) : (
              <span className="text-xs text-white/50">Cargá un código o SKU en el producto.</span>
            )}
          </div>
        )}
      </div>
      {selected?.classification.notice && <p className="mt-1.5 pl-6.5 text-xs text-amber-300">{selected.classification.notice}</p>}
      {error && <p role="alert" className="mt-1.5 pl-6.5 text-xs font-bold text-red-300">{error}</p>}
    </li>
  )
}

function ProductResult({ product, maxCopies, queuedCopies, onAdd, onGenerated }: {
  product: LabelCatalogProduct
  maxCopies: number
  queuedCopies: ReadonlyMap<string, number>
  onAdd: AddTargetHandler
  onGenerated: (productId: number) => Promise<void>
}) {
  const { targets, groupAliases } = buildLabelTargets(product)
  const printable = targets.filter((target) => target.options.length > 0)
  const notes = [
    product.randomSale ? "Venta aleatoria: cada variante física lleva su propio código, así se sabe qué color se entregó." : null,
    groupAliases.length ? `Código de grupo ${groupAliases.join(", ")}: no identifica el color, no se imprime.` : null,
  ].filter((note): note is string => Boolean(note))
  return (
    <li className="rounded-xl border border-white/10 bg-white/3 p-3 sm:p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black leading-5 text-white">{product.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {!product.active && <AdminBadge tone="warning">Producto inactivo</AdminBadge>}
            {product.randomSale && <AdminBadge tone="info">Venta aleatoria</AdminBadge>}
            <span className="text-11px font-bold text-white/50">
              {product.variants.length ? plural(product.variants.length, "variante") : "Sin variantes"}
            </span>
          </div>
        </div>
        {printable.length > 1 && (
          <AdminGhostButton size="sm" icon={<Plus className="size-3.5" />} onClick={() => printable.forEach((target) => onAdd(target, target.options[0].code, 1))}>
            Agregar todas ×1
          </AdminGhostButton>
        )}
      </div>
      {notes.map((note) => (
        <p key={note} className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-white/55">
          <Info className="mt-0.5 size-3.5 shrink-0 text-beyonix-cyan" aria-hidden="true" />{note}
        </p>
      ))}
      <ul className="mt-3 divide-y divide-white/8 border-t border-white/8 pt-3">
        {targets.map((target) => (
          <TargetRow key={`${target.variantId ?? 0}:${target.options.map((option) => option.code).join("|")}`} target={target} maxCopies={maxCopies} queuedCopies={queuedCopies} onAdd={onAdd} onGenerated={onGenerated} />
        ))}
      </ul>
    </li>
  )
}

export function LabelSearchPanel({ maxCopies, queuedCopies, onAdd, onProducts, className }: {
  maxCopies: number
  queuedCopies: ReadonlyMap<string, number>
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
  const [cameraOpen, setCameraOpen] = useState(false)
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

  // Lector (Enter), cámara y código ingresado en el visor: mismo camino.
  // Cada lectura exacta suma ×1; la cantidad se edita después en la cola.
  function submitCode(raw: string) {
    const code = normalizeScannedCode(raw)
    if (!code) return
    pendingScan.current = code
    setQuery(code)
    setOffset(0)
    setNotice("")
    setSearchNonce((current) => current + 1)
  }

  const trimmed = query.trim()
  return (
    <LabelStepSection
      id={LABEL_STEP_IDS.search}
      step={1}
      title="Buscar productos"
      description="Elegí la variante, el código y cuántas etiquetas necesitás."
      className={className}
    >
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          submitCode(trimmed)
        }}
      >
        <AdminTextInput
          title="Buscar"
          ariaLabel="Buscar productos y variantes"
          placeholder="Nombre, SKU, color o código de barras…"
          icon={<Search className="size-4" />}
          value={query}
          maxLength={MAX_CATALOG_SEARCH_LENGTH}
          className="h-12 text-base"
          onChange={(value) => { setQuery(value); setOffset(0); setNotice("") }}
        />
        <AdminButton className="h-11 w-full" icon={<Camera className="size-4" />} onClick={() => setCameraOpen(true)}>Escanear con cámara</AdminButton>
        <p className="flex items-start gap-1.5 text-11px leading-4 text-white/50">
          <ScanLine className="mt-px size-3.5 shrink-0 text-beyonix-cyan" aria-hidden="true" />
          Lector o cámara: si el código identifica un solo artículo se suma ×1 a la cola; escanearlo de nuevo suma otra. Después podés cambiar la cantidad.
        </p>
        {notice && <p role="status" className="text-xs font-bold text-white/80">{notice}</p>}
      </form>
      <CameraScanner open={cameraOpen} continuous paused={loading} title="Etiquetas" hint="Encuadrá el código de barras del artículo"
        feedback={notice ? { tone: notice.startsWith("Escaneado") ? "success" : "warning", message: notice } : null}
        onDetected={(code) => submitCode(code)} onClose={() => setCameraOpen(false)} />

      <div className="mt-4 flex items-center justify-between gap-2 text-11px font-black uppercase tracking-widest text-white/50">
        <span>{trimmed ? "Resultados" : "Catálogo"}{results.length > 0 && ` · ${plural(results.length, "producto")}`}</span>
        {loading && <span className="inline-flex items-center gap-1.5 normal-case tracking-normal"><LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />Buscando…</span>}
      </div>

      <div className="mt-2">
        {error && <p role="alert" className="text-sm font-bold text-red-300">{error}</p>}
        {!error && !loading && results.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <PackageSearch className="size-8 text-white/30" aria-hidden="true" />
            <p className="text-sm font-black text-white">{trimmed ? "Sin resultados" : "No hay productos cargados"}</p>
            {trimmed && <p className="max-w-xs text-xs text-white/55">Probá con otra palabra, el SKU o el código de barras completo.</p>}
          </div>
        )}
        <ul className="space-y-2.5">
          {results.map((product) => (
            <ProductResult key={product.id} product={product} maxCopies={maxCopies} queuedCopies={queuedCopies} onAdd={onAdd} onGenerated={refreshProduct} />
          ))}
        </ul>
        {hasMore && !loading && (
          <div className="mt-3 flex justify-center">
            <AdminButton size="sm" onClick={() => setOffset(results.length)}>Ver más productos</AdminButton>
          </div>
        )}
      </div>
    </LabelStepSection>
  )
}
