"use client"

import { useEffect, useEffectEvent, useRef, useState } from "react"
import { Camera, Check, Search, Trash2 } from "lucide-react"
import { AdminButton, AdminPrimaryButton, AdminSelect, AdminTextInput, adminCardClassName } from "@/app/admin/components/admin-controls"
import { CameraScanner } from "@/app/admin/sections/despachos/camera-scanner"
import { normalizeScannedCode } from "@/lib/admin/dispatch-scan"
import { MAX_CATALOG_SEARCH_LENGTH } from "@/lib/business/cost-catalog-search"
import { buildLabelTargets, type LabelCatalogProduct, type LabelTarget } from "@/lib/labels/catalog"
import { generateBeyonixVariantCode, loadLabelProducts, searchLabelCatalog } from "@/lib/labels/client"
import { parseCopies, queueItemKey, type LabelQueueItem } from "@/lib/labels/queue"
import { LabelSwatch } from "./label-swatch"

function SelectionRow({ target, item, maxCopies, onConfirm, onRemove, onRefresh }: {
  target: LabelTarget; item: LabelQueueItem | null; maxCopies: number
  onConfirm: (target: LabelTarget, code: string, copies: number, oldKey?: string) => void
  onRemove: (key: string) => void; onRefresh: (id: number) => Promise<void>
}) {
  const [code, setCode] = useState(item?.code ?? target.options[0]?.code ?? "")
  const [quantity, setQuantity] = useState(String(item?.copies ?? 1))
  const [error, setError] = useState("")
  const [generating, setGenerating] = useState(false)
  const name = [target.productName, target.variantLabel].filter(Boolean).join(" · ")
  const selectedCode = target.options.some((option) => option.code === code) ? code : target.options[0]?.code ?? ""
  const confirmed = item && !item.issue && item.code === selectedCode && quantity === String(item.copies)
  useEffect(() => setQuantity(String(item?.copies ?? 1)), [item?.copies])
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const copies = parseCopies(quantity, maxCopies)
    if (!copies || Number(quantity) > maxCopies) { setError(`Ingresá un entero entre 1 y ${maxCopies}.`); return }
    onConfirm(target, selectedCode, copies, item?.key)
    setError("")
  }
  const generate = async () => {
    if (!target.variantId || generating) return
    setGenerating(true); setError("")
    try { await generateBeyonixVariantCode(target.productId, target.variantId); await onRefresh(target.productId) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo generar el código.") }
    finally { setGenerating(false) }
  }
  return <tr className={`border-b border-white/10 last:border-0 ${item ? "bg-emerald-400/5" : ""}`}>
    <td className="max-w-0 truncate whitespace-nowrap px-3 py-2 font-bold text-white" title={target.productName}>{target.productName}{!target.active && <span className="ml-1 text-amber-300">(inactivo)</span>}</td>
    <td className="max-w-0 px-3 py-2 text-white/80" title={target.variantLabel ?? undefined}><span className="flex min-w-0 items-center gap-2"><LabelSwatch colorHex={target.colorHex} colorHexSecondary={target.colorHexSecondary} /><span className="truncate">{target.variantLabel ?? "—"}</span></span></td>
    <td className="max-w-0 truncate whitespace-nowrap px-3 py-2 font-mono text-xs text-white/75" title={target.sku ?? undefined}>{target.sku ?? "—"}</td>
    <td className="px-3 py-2">{target.options.length > 1 ? <AdminSelect title="Código de barras" ariaLabel={`Código de barras de ${name}`} value={selectedCode} onChange={(value) => { setCode(value); setError("") }} compact triggerClassName="font-mono text-xs">{target.options.map((option) => <option key={option.code} value={option.code}>{option.code}</option>)}</AdminSelect> : <span className="font-mono text-xs text-white/80">{target.options[0]?.code ?? "Sin código"}</span>}</td>
    <td className="px-3 py-2">{target.options.length ? <form noValidate onSubmit={submit} className="flex items-center gap-2">
      <input type="number" min="1" max={maxCopies} step="1" inputMode="numeric" aria-label={`Cantidad de etiquetas de ${name}`} value={quantity} onChange={(event) => { setQuantity(event.target.value); setError("") }} className="admin-control-input admin-ds-control h-9 w-16 rounded px-2 text-center text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
      <AdminPrimaryButton type="submit" size="sm" aria-label={`Confirmar etiquetas de ${name}`}>OK</AdminPrimaryButton>
      {item && <button type="button" aria-label={`Quitar ${name}`} onClick={() => onRemove(item.key)} className="cursor-pointer p-1 text-white/50 hover:text-red-300"><Trash2 className="size-4" /></button>}
      {confirmed && <span className="whitespace-nowrap text-xs font-bold text-emerald-300"><Check className="inline size-3.5" /> {item.copies}</span>}
      {item?.issue && <span role="alert" className="text-xs text-amber-300" title={item.issue}>Revisar código</span>}
      {error && <span role="alert" className="text-xs text-red-300">{error}</span>}
    </form> : <AdminButton size="sm" disabled={!target.variantId || generating} onClick={() => void generate()}>{generating ? "Generando…" : target.variantId ? "Generar código" : "Sin código"}</AdminButton>}</td>
  </tr>
}

export function LabelSelectionPanel({ queue, products, maxCopies, onAdd, onConfirm, onRemove, onProducts }: {
  queue: readonly LabelQueueItem[]; products: ReadonlyMap<number, LabelCatalogProduct>; maxCopies: number
  onAdd: (target: LabelTarget, code: string, copies: number) => void
  onConfirm: (target: LabelTarget, code: string, copies: number, oldKey?: string) => void
  onRemove: (key: string) => void; onProducts: (products: LabelCatalogProduct[]) => void
}) {
  const [query, setQuery] = useState("")
  const [offset, setOffset] = useState(0)
  const [results, setResults] = useState<LabelCatalogProduct[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [cameraOpen, setCameraOpen] = useState(false)
  const [nonce, setNonce] = useState(0)
  const pendingScan = useRef<string | null>(null)
  const report = useEffectEvent(onProducts)
  const addScanned = useEffectEvent(onAdd)
  useEffect(() => {
    const controller = new AbortController(); let current = true
    setLoading(true); setError("")
    const timer = window.setTimeout(async () => {
      try {
        const page = await searchLabelCatalog(query, offset, controller.signal)
        if (!current) return
        setResults((before) => offset === 0 ? page.items : [...before, ...page.items.filter((item) => !before.some((known) => known.id === item.id))])
        setHasMore(page.hasMore); report(page.items)
        const scanned = pendingScan.current
        if (scanned && scanned === query.trim()) {
          pendingScan.current = null
          const matches = page.items.flatMap((product) => buildLabelTargets(product).targets.flatMap((target) => {
            const option = target.options.find((candidate) => candidate.code.toUpperCase() === scanned.toUpperCase())
            return option ? [{ target, code: option.code }] : []
          }))
          if (matches.length === 1) { addScanned(matches[0].target, matches[0].code, 1); setQuery(""); setNotice(`Escaneado: ${scanned} agregado ×1.`) }
          else setNotice(matches.length ? "El código coincide con más de un artículo: elegilo de la lista." : "No hay un artículo con ese código exacto.")
        }
      } catch { if (current) { setError("No se pudieron cargar los artículos."); if (offset === 0) setResults([]) } }
      finally { if (current) setLoading(false) }
    }, offset === 0 && !pendingScan.current ? 300 : 0)
    return () => { current = false; window.clearTimeout(timer); controller.abort() }
  }, [query, offset, nonce])
  const scan = (raw: string) => { const code = normalizeScannedCode(raw); if (!code) return; pendingScan.current = code; setQuery(code); setOffset(0); setNotice(""); setNonce((value) => value + 1) }
  const refresh = async (id: number) => { const [product] = await loadLabelProducts([id]); if (product) { setResults((before) => before.map((item) => item.id === id ? product : item)); onProducts([product]) } }
  const visible = results.flatMap((product) => buildLabelTargets(product).targets.flatMap((target) => {
    const selected = queue.filter((item) => item.productId === target.productId && item.variantId === target.variantId)
    return (selected.length ? selected : [null]).map((item) => ({ target, item }))
  }))
  const shown = new Set(visible.map(({ item }) => item?.key).filter(Boolean))
  const offscreen = queue.filter((item) => !shown.has(item.key)).map((item) => {
    const product = products.get(item.productId)
    const target = product ? buildLabelTargets(product).targets.find((candidate) => candidate.variantId === item.variantId) : null
    return { item, target }
  })
  return <div className={`${adminCardClassName} min-w-0 p-3 sm:p-4`}>
    <div className="flex flex-wrap gap-2"><form className="min-w-52 flex-1" onSubmit={(event) => { event.preventDefault(); scan(query.trim()) }}><AdminTextInput title="Buscar" ariaLabel="Buscar productos y variantes" placeholder="Nombre, SKU, color o código de barras…" icon={<Search className="size-4" />} value={query} maxLength={MAX_CATALOG_SEARCH_LENGTH} onChange={(value) => { setQuery(value); setOffset(0); setNotice("") }} /></form><AdminButton size="sm" icon={<Camera className="size-4" />} onClick={() => setCameraOpen(true)}>Escanear</AdminButton></div>
    {notice && <p role="status" className="mt-2 text-xs text-white/80">{notice}</p>}{error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    <CameraScanner open={cameraOpen} continuous paused={loading} title="Etiquetas" hint="Encuadrá el código de barras del artículo" feedback={notice ? { tone: notice.startsWith("Escaneado") ? "success" : "warning", message: notice } : null} onDetected={scan} onClose={() => setCameraOpen(false)} />
    <div className="mt-3 min-w-0 overflow-x-auto">
      <table className="w-full min-w-[960px] table-fixed text-left text-sm" aria-label="Productos para etiquetas">
        <colgroup>
          <col className="w-[27%]" /><col className="w-[16%]" /><col className="w-[12%]" />
          <col className="w-[21%]" /><col className="w-[24%]" />
        </colgroup>
        <thead><tr className="border-b border-white/15 text-xs uppercase text-white/55">
          <th className="px-3 py-2">Producto</th><th className="px-3 py-2">Variante</th>
          <th className="px-3 py-2">SKU</th><th className="px-3 py-2">Código de barras</th>
          <th className="px-3 py-2">Cantidad / acción</th>
        </tr></thead>
        <tbody>{[...offscreen.filter((row): row is { item: LabelQueueItem; target: LabelTarget } => Boolean(row.target)), ...visible].map(({ target, item }) => (
          <SelectionRow
            key={item?.key ?? queueItemKey(target.productId, target.variantId, target.options[0]?.code ?? "")}
            target={target} item={item} maxCopies={maxCopies}
            onConfirm={onConfirm} onRemove={onRemove} onRefresh={refresh}
          />
        ))}</tbody>
      </table>
      {!loading && !visible.length && !offscreen.length && <p className="py-8 text-center text-sm text-white/60">{query.trim() ? "Sin resultados" : "No hay productos cargados"}</p>}
    </div>
    {hasMore && !loading && <div className="mt-3 flex justify-center"><AdminButton size="sm" onClick={() => setOffset(results.length)}>Ver más productos</AdminButton></div>}
  </div>
}
