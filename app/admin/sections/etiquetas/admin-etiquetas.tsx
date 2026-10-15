"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { Download, FileCode2, Printer } from "lucide-react"

import {
  AdminButton,
  AdminInfoBlock,
  AdminModal,
  AdminPageHeader,
  AdminPrimaryButton,
  adminCardClassName,
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
import { layoutNotices, type LabelPlan } from "@/lib/labels/layout"
import { labelQueueStore, labelSettingsStore } from "@/lib/labels/local-store"
import { addToQueue, createQueueItem, expandQueue, findTarget, queueLabelCount, reconcileQueue, type LabelQueueItem } from "@/lib/labels/queue"
import { buildPrintDocument, prepareBatch } from "@/lib/labels/render"
import { MAX_BATCH_LABELS, normalizeLabelSettings, type LabelSettings } from "@/lib/labels/settings"
import { buildZpl, zplUnavailableReason } from "@/lib/labels/zpl"
import { cn } from "@/lib/utils"

import { LabelOutputPanel, describeOutput, type PrintBlocker } from "./label-output-panel"
import { LabelSheetPreview, LabelZoomModal, PreviewLegend, PreviewPager, previewPageCount } from "./label-preview"
import { LabelQueuePanel } from "./label-queue-panel"
import { LabelSearchPanel } from "./label-search-panel"
import { LabelSettingsPanel, describeFormat } from "./label-settings-panel"
import { LABEL_STEP_IDS, LabelStepsBar, plural, type LabelStepStatus } from "./label-ui"

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

// Dónde cae cada artículo de la cola dentro de la tanda (las copias de un
// artículo siempre quedan consecutivas).
function queuePlacements(labels: readonly LabelQueueItem[], plan: LabelPlan) {
  const placements = new Map<string, string>()
  if (plan.error || !plan.grid.perPage) return placements
  const ranges = new Map<string, { first: number; last: number }>()
  labels.forEach((item, index) => {
    const range = ranges.get(item.key)
    if (range) range.last = index
    else ranges.set(item.key, { first: index, last: index })
  })
  const unit = plan.mode === "a4" ? ["hoja", "hojas"] : ["fila", "filas"]
  ranges.forEach(({ first, last }, key) => {
    const from = Math.floor(first / plan.grid.perPage) + 1
    const to = Math.floor(last / plan.grid.perPage) + 1
    const labelsText = first === last ? `Etiqueta ${first + 1}` : `Etiquetas ${first + 1}–${last + 1}`
    placements.set(key, `${labelsText} · ${from === to ? `${unit[0]} ${from}` : `${unit[1]} ${from}–${to}`}`)
  })
  return placements
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
  const printBlocker: PrintBlocker | null = !total
    ? { text: "La cola está vacía.", pending: false }
    : plan.overLimit
      ? { text: `La tanda supera las ${MAX_BATCH_LABELS} etiquetas. Dividila en tandas más chicas.`, pending: false }
      : plan.error
        ? { text: plan.error, pending: false }
        : blockedCodes.length
          ? { text: `No se pudo generar el código ${blockedCodes.join(", ")}. Quitalo de la cola.`, pending: false }
          : loadingPatterns
            ? { text: "Generando códigos de barras…", pending: true }
            : null
  const queuedCopies = useMemo(() => new Map(queue.map((item) => [item.key, item.copies])), [queue])
  const placements = useMemo(() => queuePlacements(labels, plan), [labels, plan])
  const issues = queue.filter((item) => item.issue || patternErrors[item.code]).length

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
  const outputDisabled = Boolean(printBlocker) || busy !== null
  const outputSummary = total ? `${plural(total, "etiqueta")} · ${describeOutput(plan)}` : "La cola está vacía"

  const steps: LabelStepStatus[] = [
    {
      id: LABEL_STEP_IDS.search,
      title: "Buscar y agregar",
      status: queue.length ? "Podés seguir sumando artículos" : "Buscá o escaneá un producto",
      state: queue.length ? "done" : "current",
    },
    {
      id: LABEL_STEP_IDS.queue,
      title: "Revisar la cola",
      status: issues ? `${plural(issues, "artículo")} con aviso` : queue.length ? `${plural(queue.length, "artículo")} · ${plural(total, "etiqueta")}` : "Vacía",
      state: issues ? "blocked" : total ? "done" : "idle",
    },
    {
      id: LABEL_STEP_IDS.format,
      title: "Elegir formato",
      status: describeFormat(settings),
      state: plan.error ? "blocked" : total ? "done" : "idle",
    },
    {
      id: LABEL_STEP_IDS.output,
      title: "Revisar e imprimir",
      status: !total ? "Esperando etiquetas" : printBlocker ? printBlocker.text : `Listo · ${describeOutput(plan)}`,
      state: !total ? "idle" : printBlocker && !printBlocker.pending ? "blocked" : "current",
    },
  ]

  const outputActions = (
    <div className="flex flex-wrap items-center gap-2">
      <AdminPrimaryButton icon={<Printer className="size-4" />} disabled={outputDisabled} onClick={() => void runOutput("print")}>
        {busy === "print" ? "Preparando…" : "Imprimir"}
      </AdminPrimaryButton>
      <AdminButton icon={<Download className="size-4" />} disabled={outputDisabled} onClick={() => void runOutput("pdf")}>
        {busy === "pdf" ? "Generando…" : "Descargar PDF"}
      </AdminButton>
      {settings.mode === "thermal" && (
        <AdminButton icon={<FileCode2 className="size-4" />} title={zplReason ?? "ZPL para Zebra / Honeywell (beta, sin prueba en impresora física)"} disabled={outputDisabled || Boolean(zplReason)} onClick={() => void runOutput("zpl")}>
          {busy === "zpl" ? "Generando…" : "Exportar ZPL"}
        </AdminButton>
      )}
    </div>
  )

  return (
    <div className={cn(adminPageClassName, "mx-auto w-full max-w-1600px")}>
      <AdminPageHeader
        eyebrow="Productos"
        title="Etiquetas"
        description="Armá una tanda de etiquetas con código de barras para hoja A4 o impresora térmica: buscá, revisá la cola, elegí el formato e imprimí."
      />

      <LabelStepsBar steps={steps} />

      {message && (
        <AdminInfoBlock role={message.tone === "danger" ? "alert" : "status"} tone={message.tone}>
          {message.text}
        </AdminInfoBlock>
      )}

      {/* xl: (1 buscar + 2 cola) | (3 formato + 4 vista previa). 2xl: buscar · cola · formato y vista previa. */}
      <div className="grid items-start gap-5 xl:grid-cols-2 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)]">
        <div className="grid min-w-0 items-start gap-5 2xl:grid-cols-2">
          <LabelSearchPanel maxCopies={settings.maxCopiesPerItem} queuedCopies={queuedCopies} onAdd={addTarget} onProducts={mergeProducts} />
          <LabelQueuePanel
            queue={queue}
            products={products}
            maxCopies={settings.maxCopiesPerItem}
            order={settings.order}
            patternErrors={patternErrors}
            placements={placements}
            batches={batches}
            historyAvailable={configLoaded && !storageUnavailable}
            onRepeat={(entry) => void repeatBatch(entry)}
            update={updateQueue}
          />
        </div>
        <div className="min-w-0 space-y-5">
          <LabelSettingsPanel
            settings={settings}
            onChange={updateSettings}
            presets={presets}
            storageUnavailable={storageUnavailable}
            preferenceError={preferenceError}
            onSavePreset={savePreset}
            onDeletePreset={removePreset}
          />
          <LabelOutputPanel
            plan={plan}
            drawings={drawings}
            labels={labels}
            settings={settings}
            total={total}
            page={currentPage}
            pageCount={pageCount}
            blocker={printBlocker}
            warnings={warnings}
            notices={notices}
            onPage={setPage}
            onZoom={setZoomIndex}
            onExpand={() => setPreviewOpen(true)}
          />
        </div>
      </div>

      {/* Paso final siempre a mano: resumen de la tanda + salidas. */}
      <div className={cn(adminCardClassName, "admin-label-print-dock sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 px-4 py-3")} role="region" aria-label="Imprimir o descargar">
        <div className="min-w-0">
          <p className="text-sm font-black text-white">{outputSummary}</p>
          <p className="truncate text-xs text-white/55">{total ? (printBlocker ? printBlocker.text : describeFormat(settings)) : "Agregá artículos para habilitar la impresión."}</p>
        </div>
        {outputActions}
      </div>

      <AdminModal
        open={previewOpen}
        wide
        title="Vista previa"
        description={`${outputSummary} · ${describeFormat(settings)}`}
        onClose={() => setPreviewOpen(false)}
        footer={<div className="flex justify-end">{outputActions}</div>}
      >
        <div className="space-y-3">
          <div className="max-h-[72vh] overflow-auto rounded-xl bg-zinc-300/70 p-3 sm:p-5">
            <div className="mx-auto max-w-3xl">
              <LabelSheetPreview plan={plan} drawings={drawings} labels={labels} settings={settings} page={currentPage} onSelect={setZoomIndex} />
            </div>
          </div>
          <PreviewPager page={currentPage} count={pageCount} unit={plan.mode === "thermal" ? "Tramo" : "Hoja"} onChange={setPage} />
          <PreviewLegend mode={plan.mode} />
        </div>
      </AdminModal>
      <LabelZoomModal key={zoomIndex ?? "none"} item={zoomItem} drawing={zoomDrawing} settings={settings} onClose={() => setZoomIndex(null)} />
    </div>
  )
}
