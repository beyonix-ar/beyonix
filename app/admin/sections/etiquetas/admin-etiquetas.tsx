"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Download, Eye, FileCode2, Printer, TriangleAlert } from "lucide-react"

import {
  AdminButton,
  AdminInfoBlock,
  AdminModal,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSection,
  adminPageClassName,
} from "@/app/admin/components/admin-controls"
import { printHtmlDocument } from "@/lib/barcodes/print-labels"
import type { LabelCatalogProduct, LabelTarget } from "@/lib/labels/catalog"
import {
  deleteLabelPreset,
  fetchBarcodePatterns,
  loadLabelConfig,
  loadLabelProducts,
  saveLabelBatch,
  saveLabelPreference,
  saveLabelPreset,
  LabelApiError,
} from "@/lib/labels/client"
import type { BarcodePattern } from "@/lib/labels/drawing"
import { defaultBatchName, toBatchItems, type LabelBatchOutput, type LabelBatchSummary, type LabelPreset } from "@/lib/labels/history"
import { layoutNotices } from "@/lib/labels/layout"
import { labelQueueStore, labelSettingsStore } from "@/lib/labels/local-store"
import { addToQueue, createQueueItem, expandQueue, findTarget, queueLabelCount, reconcileQueue, type LabelQueueItem } from "@/lib/labels/queue"
import { buildPrintDocument, prepareBatch } from "@/lib/labels/render"
import { MAX_BATCH_LABELS, normalizeLabelSettings, type LabelSettings } from "@/lib/labels/settings"
import { buildZpl, zplUnavailableReason } from "@/lib/labels/zpl"
import { cn } from "@/lib/utils"

import { LabelQueuePanel } from "./label-queue-panel"
import { LabelSearchPanel } from "./label-search-panel"
import { LabelSettingsPanel } from "./label-settings-panel"
import { LabelSheetPreview, LabelZoomModal, PreviewPager, formatNumber, previewPageCount } from "./label-preview"

const PREFERENCE_SAVE_DELAY_MS = 1200

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function fileStamp() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <p className="text-10px font-black uppercase tracking-widest text-white/50">{label}</p>
      <p className="text-xl font-black text-white">{value}</p>
    </div>
  )
}

export function AdminEtiquetas() {
  const queue = useSyncExternalStore(labelQueueStore.subscribe, labelQueueStore.get, labelQueueStore.getServer)
  const settings = useSyncExternalStore(labelSettingsStore.subscribe, labelSettingsStore.get, labelSettingsStore.getServer)
  const [products, setProducts] = useState<ReadonlyMap<number, LabelCatalogProduct>>(new Map())
  const [patterns, setPatterns] = useState<ReadonlyMap<string, BarcodePattern>>(new Map())
  const [patternErrors, setPatternErrors] = useState<Record<string, string>>({})
  const [presets, setPresets] = useState<LabelPreset[]>([])
  const [batches, setBatches] = useState<LabelBatchSummary[]>([])
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [preferenceError, setPreferenceError] = useState("")
  const [page, setPage] = useState(0)
  const [zoomIndex, setZoomIndex] = useState<number | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [busy, setBusy] = useState<LabelBatchOutput | null>(null)
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null)
  const settingsTouched = useRef(false)
  // Filas ya validadas contra el catálogo del servidor en esta sesión.
  const validatedKeys = useRef(new Set<string>())

  const updateQueue = useCallback((change: (current: LabelQueueItem[]) => LabelQueueItem[]) => labelQueueStore.update(change), [])
  const updateSettings = useCallback((change: (current: LabelSettings) => LabelSettings) => {
    settingsTouched.current = true
    labelSettingsStore.update((current) => normalizeLabelSettings(change(current)))
  }, [])

  const mergeProducts = useCallback((items: LabelCatalogProduct[]) => {
    if (!items.length) return
    setProducts((current) => {
      const next = new Map(current)
      items.forEach((product) => next.set(product.id, product))
      return next
    })
  }, [])

  // Presets, preferencia guardada e historial: una sola consulta.
  useEffect(() => {
    let current = true
    loadLabelConfig()
      .then((config) => {
        if (!current) return
        setPresets(config.presets)
        setBatches(config.batches)
        setStorageUnavailable(config.storageUnavailable)
        if (config.preference && !settingsTouched.current) labelSettingsStore.set(config.preference)
      })
      .catch(() => current && setPreferenceError("No se pudo cargar la configuración guardada; se usa la de este navegador."))
      .finally(() => current && setConfigLoaded(true))
    return () => { current = false }
  }, [])

  // Toda fila que llega a la cola sin validar (guardada en el navegador o
  // agregada desde Productos, incluso en otra pestaña) se revalida contra el
  // catálogo actual: nombre, color, SKU, precio y que el código siga siendo suyo.
  useEffect(() => {
    const pending = queue.filter((item) => !validatedKeys.current.has(item.key))
    if (!pending.length) return
    pending.forEach((item) => validatedKeys.current.add(item.key))
    const keys = new Set(pending.map((item) => item.key))
    const missingIds = [...new Set(pending.filter((item) => !products.has(item.productId)).map((item) => item.productId))]
    const apply = (catalog: LabelCatalogProduct[]) => labelQueueStore.update((current) => {
      const fresh = new Map(reconcileQueue(current.filter((item) => keys.has(item.key)), catalog).map((item) => [item.key, item]))
      return current.map((item) => fresh.get(item.key) ?? item)
    })
    if (!missingIds.length) { apply([...products.values()]); return }
    loadLabelProducts(missingIds)
      .then((items) => {
        mergeProducts(items)
        apply([...products.values(), ...items])
      })
      .catch(() => {
        keys.forEach((key) => validatedKeys.current.delete(key))
        setMessage({ tone: "danger", text: "No se pudo revalidar la cola con el catálogo. Revisá la conexión antes de imprimir." })
      })
  }, [queue, products, mergeProducts])

  // Recordar la configuración (debounce) sólo cuando la cambia el usuario.
  useEffect(() => {
    if (!settingsTouched.current || !configLoaded || storageUnavailable) return
    const timer = window.setTimeout(() => {
      saveLabelPreference(settings)
        .then(() => setPreferenceError(""))
        .catch(() => setPreferenceError("No se pudo guardar la configuración en tu cuenta; queda recordada en este navegador."))
    }, PREFERENCE_SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [settings, configLoaded, storageUnavailable])

  // Patrones de barras de los códigos de la cola que todavía no se tienen.
  const queueCodes = useMemo(() => [...new Set(queue.filter((item) => !item.issue).map((item) => item.code))].sort(), [queue])
  const missingCodes = useMemo(() => queueCodes.filter((code) => !patterns.has(code) && !patternErrors[code]), [queueCodes, patterns, patternErrors])
  const missingKey = missingCodes.join("\n")
  useEffect(() => {
    if (!missingKey) return
    const controller = new AbortController()
    fetchBarcodePatterns(missingKey.split("\n"), controller.signal)
      .then((result) => {
        setPatterns((current) => {
          const next = new Map(current)
          Object.entries(result.patterns).forEach(([code, pattern]) => next.set(code, pattern))
          return next
        })
        if (Object.keys(result.errors).length) setPatternErrors((current) => ({ ...current, ...result.errors }))
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const text = error instanceof Error ? error.message : "No se pudieron generar los códigos de barras."
        setMessage({ tone: "danger", text })
      })
    return () => controller.abort()
  }, [missingKey])

  const labels = useMemo(() => expandQueue(queue, settings.order), [queue, settings.order])
  const batch = useMemo(() => prepareBatch(labels, patterns, settings), [labels, patterns, settings])
  const { plan, drawings } = batch
  const pageCount = previewPageCount(plan)
  const currentPage = Math.min(page, pageCount - 1)
  const total = queueLabelCount(queue)
  const loadingPatterns = missingCodes.length > 0
  const blockedCodes = queueCodes.filter((code) => patternErrors[code])
  const warnings = useMemo(() => {
    const unique = new Map<string, string>()
    drawings.forEach((drawing) => drawing.warnings.forEach((warning) => unique.set(warning.message, warning.message)))
    return [...unique.values()]
  }, [drawings])
  const notices = layoutNotices(settings)
  const zplReason = zplUnavailableReason(settings)
  const printBlocker = !total
    ? "La cola está vacía."
    : plan.overLimit
      ? `La tanda supera las ${MAX_BATCH_LABELS} etiquetas. Dividila en tandas más chicas.`
      : plan.error
        ? plan.error
        : blockedCodes.length
          ? `No se pudo generar el código ${blockedCodes.join(", ")}. Quitalo de la cola.`
          : loadingPatterns
            ? "Generando códigos de barras…"
            : null

  const addTarget = useCallback((target: LabelTarget, code: string, copies: number) => {
    const item = createQueueItem(target, code, copies)
    if (!item) return
    const max = labelSettingsStore.get().maxCopiesPerItem
    const outcome = addToQueue(labelQueueStore.get(), item, max)
    validatedKeys.current.add(item.key)
    labelQueueStore.set(outcome.queue)
    const name = [target.productName, target.variantLabel].filter(Boolean).join(" · ")
    setMessage(outcome.rejected
      ? { tone: "danger", text: "La cola llegó al máximo de artículos. Imprimí o vaciá antes de seguir." }
      : { tone: "success", text: `${outcome.merged ? "Sumado" : "Agregado"}: ${name} ×${copies}${outcome.clamped ? ` (tope de ${max} por artículo)` : ""}.` })
  }, [])

  async function repeatBatch(entry: LabelBatchSummary) {
    try {
      const items = await loadLabelProducts(entry.items.map((item) => item.productId))
      mergeProducts(items)
      const max = labelSettingsStore.get().maxCopiesPerItem
      let next = labelQueueStore.get()
      let added = 0
      for (const batchItem of entry.items) {
        const target = findTarget(items, batchItem.productId, batchItem.variantId)
        const item = target && createQueueItem(target, batchItem.code, batchItem.copies)
        if (!item) continue
        added += 1
        validatedKeys.current.add(item.key)
        next = addToQueue(next, { ...item, labelName: batchItem.labelName }, max).queue
      }
      labelQueueStore.set(next)
      const skipped = entry.items.length - added
      setMessage({ tone: skipped ? "info" : "success", text: `Tanda "${entry.name}" agregada a la cola${skipped ? `; ${skipped} ${skipped === 1 ? "artículo ya no existe o cambió de código" : "artículos ya no existen o cambiaron de código"}` : ""}.` })
    } catch {
      setMessage({ tone: "danger", text: "No se pudo cargar la tanda." })
    }
  }

  function recordBatch(output: LabelBatchOutput) {
    if (storageUnavailable) return
    const items = toBatchItems(queue)
    saveLabelBatch(defaultBatchName(queue.filter((item) => !item.issue)), items, output)
      .then((saved) => { if (saved) setBatches((current) => [saved, ...current].slice(0, 20)) })
      .catch(() => setMessage({ tone: "info", text: "Las etiquetas salieron, pero no se pudo guardar la tanda en el historial." }))
  }

  async function runOutput(output: LabelBatchOutput) {
    if (busy || printBlocker) return
    setBusy(output)
    setMessage(null)
    try {
      if (output === "print") {
        await printHtmlDocument(buildPrintDocument(batch, settings))
      } else if (output === "pdf") {
        const { buildLabelsPdf } = await import("@/lib/labels/pdf")
        const bytes = await buildLabelsPdf(batch, settings)
        const buffer = new ArrayBuffer(bytes.byteLength)
        new Uint8Array(buffer).set(bytes)
        downloadBlob(new Blob([buffer], { type: "application/pdf" }), `etiquetas-beyonix-${fileStamp()}.pdf`)
      } else {
        downloadBlob(new Blob([buildZpl(batch, settings)], { type: "text/plain;charset=utf-8" }), `etiquetas-beyonix-${fileStamp()}.zpl`)
      }
      recordBatch(output)
      setMessage({ tone: "success", text: output === "print" ? `Enviadas ${plan.totalLabels} etiquetas al diálogo de impresión.` : `Archivo ${output === "pdf" ? "PDF" : "ZPL"} generado con ${plan.totalLabels} etiquetas.` })
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "No se pudieron generar las etiquetas." })
    } finally {
      setBusy(null)
    }
  }

  async function savePreset(name: string, overwrite: boolean): Promise<"saved" | "exists"> {
    try {
      const preset = await saveLabelPreset(name, labelSettingsStore.get(), overwrite)
      setPresets((current) => [...current.filter((item) => item.id !== preset.id), preset].sort((left, right) => left.name.localeCompare(right.name, "es")))
      return "saved"
    } catch (error) {
      if (error instanceof LabelApiError && error.status === 409) return "exists"
      throw error
    }
  }

  async function removePreset(preset: LabelPreset) {
    await deleteLabelPreset(preset.id)
    setPresets((current) => current.filter((item) => item.id !== preset.id))
  }

  const zoomItem = zoomIndex != null ? labels[zoomIndex] ?? null : null
  const zoomDrawing = zoomIndex != null ? drawings[zoomIndex] ?? null : null
  const sample = drawings[0]

  const preview = (large: boolean) => (
    <div className="space-y-3">
      {total > 0 ? (
        <div className={cn("bg-zinc-300/70 p-3 sm:p-4", large && "max-h-[75vh] overflow-auto")}>
          <div className={large ? "mx-auto max-w-3xl" : "mx-auto max-w-md"}>
            <LabelSheetPreview plan={plan} drawings={drawings} labels={labels} settings={settings} page={currentPage} onSelect={setZoomIndex} />
          </div>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-white/55">La vista previa aparece cuando agregás etiquetas a la cola.</p>
      )}
      <PreviewPager page={currentPage} count={pageCount} unit={plan.mode === "thermal" ? "Tramo" : "Hoja"} onChange={setPage} />
      {total > 0 && <p className="text-center text-11px text-white/50">Tocá una etiqueta para ampliarla y ver sus medidas.</p>}
    </div>
  )

  const actions = (
    <div className="flex flex-wrap gap-2">
      <AdminButton icon={<Eye className="size-4" />} disabled={!total} onClick={() => setPreviewOpen(true)}>Vista previa</AdminButton>
      <AdminPrimaryButton icon={<Printer className="size-4" />} disabled={Boolean(printBlocker) || busy !== null} onClick={() => void runOutput("print")}>
        {busy === "print" ? "Preparando…" : "Imprimir"}
      </AdminPrimaryButton>
      <AdminButton icon={<Download className="size-4" />} disabled={Boolean(printBlocker) || busy !== null} onClick={() => void runOutput("pdf")}>
        {busy === "pdf" ? "Generando…" : "Descargar PDF"}
      </AdminButton>
      {settings.mode === "thermal" && (
        <AdminButton icon={<FileCode2 className="size-4" />} title={zplReason ?? "ZPL para Zebra / Honeywell (beta, sin prueba en impresora física)"} disabled={Boolean(printBlocker) || Boolean(zplReason) || busy !== null} onClick={() => void runOutput("zpl")}>
          {busy === "zpl" ? "Generando…" : "Exportar ZPL"}
        </AdminButton>
      )}
    </div>
  )

  return (
    <div className={cn(adminPageClassName, "mx-auto w-full max-w-1600px")}>
      <AdminPageHeader eyebrow="Productos" title="Etiquetas" description="Generación e impresión de códigos" actions={actions} />

      {message && (
        <AdminInfoBlock role={message.tone === "danger" ? "alert" : "status"} tone={message.tone}>
          {message.text}
        </AdminInfoBlock>
      )}

      {/* xl: buscar + cola apilados | vista previa. 2xl: buscar · cola · vista previa. */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1.25fr)]">
        <div className="grid min-w-0 items-start gap-5 2xl:grid-cols-2">
          <LabelSearchPanel maxCopies={settings.maxCopiesPerItem} onAdd={addTarget} onProducts={mergeProducts} />
          <LabelQueuePanel
            queue={queue}
            products={products}
            maxCopies={settings.maxCopiesPerItem}
            patternErrors={patternErrors}
            batches={batches}
            historyAvailable={configLoaded && !storageUnavailable}
            onRepeat={(entry) => void repeatBatch(entry)}
            update={updateQueue}
          />
        </div>
        <div className="min-w-0 space-y-5">
          <AdminSection compact icon={<Eye className="size-4" />} title="Vista previa" description={`Etiqueta ${formatNumber(plan.designWidthMm)} × ${formatNumber(plan.designHeightMm)} mm${sample?.barcode ? ` · código ${formatNumber(sample.barcode.box.widthMm)} × ${formatNumber(sample.barcode.box.heightMm)} mm` : ""} · margen ${formatNumber(settings.paddingMm)} mm`}>
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Etiquetas" value={total} />
              {plan.mode === "a4" ? (
                <>
                  <Stat label="Por hoja" value={plan.grid.perPage ? `${plan.grid.perPage} (${plan.grid.columns}×${plan.grid.rows})` : "—"} />
                  <Stat label="Hojas" value={plan.pages.length} />
                  <Stat label="Espacios libres" value={plan.freeSlots} />
                </>
              ) : (
                <>
                  <Stat label="Por página" value={1} />
                  <Stat label="Largo de rollo" value={plan.rollLengthMm ? `${formatNumber(plan.rollLengthMm / 10)} cm` : "—"} />
                  <Stat label="DPI" value={settings.dpi} />
                </>
              )}
            </div>
            {(warnings.length > 0 || notices.length > 0 || printBlocker) && (
              <div className="mb-4 space-y-2">
                {printBlocker && total > 0 && <AdminInfoBlock tone={loadingPatterns && !blockedCodes.length && !plan.overLimit && !plan.error ? "info" : "danger"}>{printBlocker}</AdminInfoBlock>}
                {warnings.map((warning) => (
                  <AdminInfoBlock key={warning} tone="warning" icon={<TriangleAlert className="size-4" aria-hidden="true" />}>{warning}</AdminInfoBlock>
                ))}
                {notices.map((notice) => <AdminInfoBlock key={notice.message} tone={notice.tone}>{notice.message}</AdminInfoBlock>)}
              </div>
            )}
            {preview(false)}
            {plan.mode === "a4" && total > 0 && (
              <p className="mt-3 text-xs text-white/55">
                Papel sin usar: {plan.unusedPercent} %. Al imprimir elegí escala 100 % (“Tamaño real”), sin “Ajustar a la página”.
              </p>
            )}
          </AdminSection>
          <LabelSettingsPanel
            settings={settings}
            onChange={updateSettings}
            presets={presets}
            storageUnavailable={storageUnavailable}
            preferenceError={preferenceError}
            onSavePreset={savePreset}
            onDeletePreset={removePreset}
          />
        </div>
      </div>

      <AdminModal open={previewOpen} wide title="Vista previa" description={`${total} etiquetas · ${plan.mode === "a4" ? `${plan.pages.length} ${plan.pages.length === 1 ? "hoja" : "hojas"} A4` : "impresora térmica"}`} onClose={() => setPreviewOpen(false)} footer={<div className="flex justify-end">{actions}</div>}>
        {preview(true)}
      </AdminModal>
      <LabelZoomModal key={zoomIndex ?? "none"} item={zoomItem} drawing={zoomDrawing} settings={settings} onClose={() => setZoomIndex(null)} />
    </div>
  )
}
